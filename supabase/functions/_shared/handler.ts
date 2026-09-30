import { verifyShopifyHmac } from "./hmac.ts";
import type { PartyMatch } from "./match.ts";
import { mapCustomer, mapOrder, preserveShopifyBigInts, type CustomerRecord, type OrderRecord } from "./map.ts";

export const HANDLED_TOPICS = new Set([
  "orders/create",
  "orders/paid",
  "orders/updated",
  "customers/create",
  "customers/update",
]);

const CUSTOMER_TOPICS = new Set(["customers/create", "customers/update"]);

export type PartyQuery = {
  email: string | null;
  company: string | null;
  country: string | null;
};

export type ConversionInput = {
  email: string | null;
  shopifyOrderId: string;
  amount: string | null;
  currency: string | null;
  barberId: string | null;
  organizationId: string | null;
};

export type SyncStore = {
  matchParty(query: PartyQuery): Promise<PartyMatch>;
  upsertContact(email: string, fullName: string | null): Promise<string | null>;
  upsertCustomer(row: CustomerRecord): Promise<void>;
  upsertOrder(row: OrderRecord): Promise<void>;
  recordConversion(input: ConversionInput): Promise<boolean>;
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

function applyParty(target: { contact_id: string | null; barber_id: string | null; organization_id: string | null; barber_lead_id: string | null }, party: PartyMatch) {
  target.contact_id = party.contactId;
  target.barber_id = party.barberId;
  target.organization_id = party.organizationId;
  target.barber_lead_id = party.apifyLeadId;
}

async function attachContact(store: SyncStore, email: string | null, name: string | null, partyContactId: string | null): Promise<string | null> {
  if (!email) {
    return partyContactId;
  }
  const contactId = await store.upsertContact(email, name);
  return contactId ?? partyContactId;
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
    if (CUSTOMER_TOPICS.has(topic)) {
      const customer = mapCustomer(payload);
      if (!customer) {
        return json({ error: "invalid customer" }, 400);
      }
      const party = await store.matchParty({
        email: customer.email,
        company: customer.company_name,
        country: customer.country,
      });
      applyParty(customer, party);
      customer.contact_id = await attachContact(store, customer.email, customer.customer_name, customer.contact_id);
      await store.upsertCustomer(customer);
      deps.log?.({
        topic,
        shopifyCustomerId: customer.shopify_customer_id,
        matched: Boolean(customer.barber_id || customer.organization_id || customer.contact_id),
        ok: true,
      });
      return json({ ok: true }, 200);
    }

    const order = mapOrder(payload, topic);
    if (!order) {
      return json({ error: "invalid order" }, 400);
    }
    const party = await store.matchParty({
      email: order.customer_email,
      company: order.company_name,
      country: order.shipping_country ?? order.billing_country,
    });
    applyParty(order, party);
    order.contact_id = await attachContact(store, order.customer_email, order.customer_name, order.contact_id);
    if (order.customer) {
      applyParty(order.customer, party);
      order.customer.contact_id = order.contact_id;
      await store.upsertCustomer(order.customer);
    }
    await store.upsertOrder(order);
    await store.recordConversion({
      email: order.customer_email,
      shopifyOrderId: order.shopify_order_id,
      amount: order.total_price,
      currency: order.currency,
      barberId: order.barber_id,
      organizationId: order.organization_id,
    });
    deps.log?.({
      topic,
      shopifyOrderId: order.shopify_order_id,
      shopifyCustomerId: order.shopify_customer_id,
      matched: Boolean(order.barber_id || order.organization_id || order.contact_id),
      ok: true,
    });
    return json({ ok: true }, 200);
  } catch {
    deps.log?.({ topic, ok: false });
    return json({ error: "sync failed" }, 500);
  }
}
