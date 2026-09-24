import { verifyShopifyHmac } from "./hmac.ts";
import { emailDomain, isFreeMailDomain, matchBarberLead, normalizeEmail, type BarberLead } from "./match.ts";
import { mapCustomer, mapOrder, preserveShopifyBigInts, type CustomerRecord, type OrderRecord } from "./map.ts";

export const HANDLED_TOPICS = new Set(["orders/create", "orders/paid", "customers/create"]);

export type SyncStore = {
  findCandidates(email: string, domain: string | null): Promise<BarberLead[]>;
  upsertCustomer(row: CustomerRecord): Promise<void>;
  upsertOrder(row: OrderRecord): Promise<void>;
};

export type WebhookDeps = {
  secret: string;
  createStore: () => SyncStore;
  log?: (event: Record<string, unknown>) => void;
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function matchLead(store: SyncStore, email: string | null): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  const domain = emailDomain(normalized);
  const domainFilter = domain && !isFreeMailDomain(domain) ? domain : null;
  const candidates = await store.findCandidates(normalized, domainFilter);
  return matchBarberLead(normalized, candidates).leadId;
}

export async function handleShopifyWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const rawBody = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!hmacHeader) {
    return json({ error: "missing hmac" }, 401);
  }
  if (!deps.secret) {
    return json({ error: "server misconfigured" }, 500);
  }

  const valid = await verifyShopifyHmac(rawBody, hmacHeader, deps.secret);
  if (!valid) {
    return json({ error: "invalid hmac" }, 401);
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  if (!HANDLED_TOPICS.has(topic)) {
    deps.log?.({ topic, ignored: true, ok: true });
    return json({ ok: true, ignored: true }, 200);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(preserveShopifyBigInts(rawBody));
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  let store: SyncStore;
  try {
    store = deps.createStore();
  } catch {
    deps.log?.({ topic, ok: false });
    return json({ error: "server misconfigured" }, 500);
  }

  try {
    if (topic === "customers/create") {
      const customer = mapCustomer(payload);
      if (!customer) {
        return json({ error: "invalid customer" }, 400);
      }
      customer.barber_lead_id = await matchLead(store, customer.email);
      await store.upsertCustomer(customer);
      deps.log?.({
        topic,
        shopifyCustomerId: customer.shopify_customer_id,
        matched: Boolean(customer.barber_lead_id),
        ok: true,
      });
      return json({ ok: true }, 200);
    }

    const order = mapOrder(payload, topic);
    if (!order) {
      return json({ error: "invalid order" }, 400);
    }
    const leadId = await matchLead(store, order.customer_email);
    order.barber_lead_id = leadId;
    if (order.customer) {
      order.customer.barber_lead_id = leadId;
      await store.upsertCustomer(order.customer);
    }
    await store.upsertOrder(order);
    deps.log?.({
      topic,
      shopifyOrderId: order.shopify_order_id,
      shopifyCustomerId: order.shopify_customer_id,
      matched: Boolean(leadId),
      ok: true,
    });
    return json({ ok: true }, 200);
  } catch {
    deps.log?.({ topic, ok: false });
    return json({ error: "sync failed" }, 500);
  }
}
