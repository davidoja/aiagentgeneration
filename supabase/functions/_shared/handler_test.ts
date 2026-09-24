import { assertEquals, assertNotEquals, assertOk } from "./assert.ts";
import { handleShopifyWebhook, type ConversionInput, type SyncStore } from "./handler.ts";
import type { CustomerRecord, OrderRecord } from "./map.ts";
import { matchParty, type PartyCatalog } from "./match.ts";

const secret = "shpss_test_secret";

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of mac) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const barberId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const apifyId = "33333333-3333-4333-8333-333333333333";

const catalog: PartyCatalog = {
  contacts: [],
  barbers: [{
    id: barberId,
    email: "owner@example-barber.test",
    organizationId: orgId,
    name: "Testsalong AB",
    country: "SE",
  }],
  organizations: [{
    id: orgId,
    displayName: "Testsalong AB",
    domains: ["https://www.frisorsalong.se/kontakt"],
    countryCodes: ["SE"],
  }],
  leads: [{
    id: apifyId,
    domain: "frisorsalong.se",
    emails: ["owner@example-barber.test"],
    company_domain_emails: ["faktura@frisorsalong.se"],
  }],
};

function memory(options: { recentEmails?: string[] } = {}) {
  const orders = new Map<string, OrderRecord>();
  const customers = new Map<string, CustomerRecord>();
  const conversions = new Map<string, ConversionInput>();
  const barberStatus = new Map<string, string>();
  const orgStatus = new Map<string, string>();
  const contacts = new Map<string, string>();
  let created = 0;
  const recent = new Set(options.recentEmails ?? []);
  const store: SyncStore = {
    matchParty(query) {
      return Promise.resolve(matchParty(query.email, query.company, query.country, catalog));
    },
    upsertContact(email) {
      const existing = contacts.get(email);
      if (existing) {
        return Promise.resolve(existing);
      }
      const id = `44444444-4444-4444-8444-${String(contacts.size + 1).padStart(12, "0")}`;
      contacts.set(email, id);
      return Promise.resolve(id);
    },
    upsertCustomer(row) {
      const prev = customers.get(row.shopify_customer_id);
      customers.set(row.shopify_customer_id, {
        ...prev,
        ...row,
        barber_id: row.barber_id ?? prev?.barber_id ?? null,
        organization_id: row.organization_id ?? prev?.organization_id ?? null,
        contact_id: row.contact_id ?? prev?.contact_id ?? null,
        barber_lead_id: row.barber_lead_id ?? prev?.barber_lead_id ?? null,
      });
      return Promise.resolve();
    },
    upsertOrder(row) {
      const prev = orders.get(row.shopify_order_id);
      orders.set(row.shopify_order_id, {
        ...prev,
        ...row,
        customer: null,
        paid_at: row.paid_at ?? prev?.paid_at ?? null,
        barber_id: row.barber_id ?? prev?.barber_id ?? null,
        organization_id: row.organization_id ?? prev?.organization_id ?? null,
        contact_id: row.contact_id ?? prev?.contact_id ?? null,
        barber_lead_id: row.barber_lead_id ?? prev?.barber_lead_id ?? null,
      });
      return Promise.resolve();
    },
    recordConversion(input) {
      if (!input.email || !recent.has(input.email)) {
        return Promise.resolve(false);
      }
      if (!conversions.has(input.shopifyOrderId)) {
        conversions.set(input.shopifyOrderId, input);
      }
      if (input.barberId && barberStatus.get(input.barberId) !== "partner") {
        barberStatus.set(input.barberId, "customer");
      }
      if (input.organizationId && orgStatus.get(input.organizationId) !== "partner") {
        orgStatus.set(input.organizationId, "customer");
      }
      return Promise.resolve(true);
    },
  };
  return {
    orders,
    customers,
    conversions,
    barberStatus,
    orgStatus,
    createStore() {
      created += 1;
      return store;
    },
    created: () => created,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/shopify-webhook", {
    method: "POST",
    headers,
    body,
  });
}

Deno.test("rejects a webhook with no HMAC header and does not touch the store", async () => {
  const db = memory();
  const response = await handleShopifyWebhook(post("{}"), {
    secret,
    createStore: db.createStore,
  });
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "missing hmac" });
  assertEquals(db.created(), 0);
});

Deno.test("rejects an invalid HMAC and does not touch the store", async () => {
  const db = memory();
  const body = JSON.stringify({ id: 1001 });
  const response = await handleShopifyWebhook(
    post(body, {
      "x-shopify-hmac-sha256": await sign('{"id":9999}'),
      "x-shopify-topic": "orders/create",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "invalid hmac" });
  assertEquals(db.created(), 0);
});

Deno.test("upserts an order and customer idempotently and matches the barber email", async () => {
  const db = memory();
  // Ids are written as text so the JS parser does not round them before signing.
  const created = [
    "{",
    '"id":820982911946154508,',
    '"order_number":1001,',
    '"name":"#1001",',
    '"email":"owner@example-barber.test",',
    '"created_at":"2026-09-24T08:00:00Z",',
    '"financial_status":"pending",',
    '"currency":"SEK",',
    '"total_price":"199.00",',
    '"subtotal_price":"159.20",',
    '"total_tax":"39.80",',
    '"total_discounts":"0.00",',
    '"customer":{"id":706405506930370084,"email":"owner@example-barber.test","first_name":"Ada","last_name":"Lovelace"},',
    '"shipping_address":{"country_code":"SE","company":"Testsalong AB"},',
    '"billing_address":{"country_code":"SE","company":"Testsalong AB"},',
    '"line_items":[{"id":1,"title":"Pomade","sku":"POM-1","quantity":2,"price":"99.50"}]',
    "}",
  ].join("");
  assertNotEquals(String(JSON.parse(created).id), "820982911946154508");

  const first = await handleShopifyWebhook(
    post(created, {
      "x-shopify-hmac-sha256": await sign(created),
      "x-shopify-topic": "orders/create",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(first.status, 200);

  const paidBody = created.replace(
    '"financial_status":"pending"',
    '"financial_status":"paid","processed_at":"2026-09-24T09:30:00Z"',
  );
  const second = await handleShopifyWebhook(
    post(paidBody, {
      "x-shopify-hmac-sha256": await sign(paidBody),
      "x-shopify-topic": "orders/paid",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(second.status, 200);

  assertEquals(db.orders.size, 1);
  assertEquals(db.customers.size, 1);
  const order = db.orders.get("820982911946154508");
  assertOk(order);
  assertEquals(order.shopify_order_id, "820982911946154508");
  assertEquals(order.order_number, 1001);
  assertEquals(order.financial_status, "paid");
  assertEquals(order.paid_at, "2026-09-24T09:30:00.000Z");
  assertEquals(order.currency, "SEK");
  assertEquals(order.total_price, "199.00");
  assertEquals(order.customer_email, "owner@example-barber.test");
  assertEquals(order.customer_name, "Ada Lovelace");
  assertEquals(order.company_name, "Testsalong AB");
  assertEquals(order.shipping_country, "SE");
  assertEquals(order.billing_country, "SE");
  assertEquals(order.barber_id, barberId);
  assertEquals(order.organization_id, orgId);
  assertEquals(order.barber_lead_id, apifyId);
  assertOk(order.contact_id);
  assertEquals(order.shopify_customer_id, "706405506930370084");
  assertEquals(order.line_items, [{
    id: "1",
    product_id: null,
    variant_id: null,
    title: "Pomade",
    sku: "POM-1",
    quantity: 2,
    price: "99.50",
  }]);
  assertEquals(db.customers.get("706405506930370084")?.barber_id, barberId);
});

Deno.test("does not domain-match a free-mail customer", async () => {
  const db = memory();
  const body = JSON.stringify({
    id: 55,
    email: "other@gmail.com",
    financial_status: "paid",
    processed_at: "2026-09-24T09:30:00Z",
    currency: "SEK",
    total_price: "10.00",
  });
  const response = await handleShopifyWebhook(
    post(body, {
      "x-shopify-hmac-sha256": await sign(body),
      "x-shopify-topic": "orders/paid",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(db.orders.get("55")?.barber_id, null);
  assertEquals(db.orders.get("55")?.organization_id, null);
  assertEquals(db.orders.get("55")?.barber_lead_id, null);
  assertEquals(db.orders.get("55")?.paid_at, "2026-09-24T09:30:00.000Z");
});

Deno.test("upserts customers/create without writing an order", async () => {
  const db = memory();
  const body = JSON.stringify({
    id: 77,
    email: "faktura@frisorsalong.se",
    first_name: "Bo",
    last_name: "Ek",
    created_at: "2026-09-01T10:00:00Z",
    default_address: { company: "Testsalong AB", country_code: "se" },
  });
  const response = await handleShopifyWebhook(
    post(body, {
      "x-shopify-hmac-sha256": await sign(body),
      "x-shopify-topic": "customers/create",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(db.orders.size, 0);
  const customer = db.customers.get("77");
  assertOk(customer);
  assertEquals(customer.customer_name, "Bo Ek");
  assertEquals(customer.company_name, "Testsalong AB");
  assertEquals(customer.country, "SE");
  assertEquals(customer.organization_id, orgId);
  assertEquals(customer.barber_id, barberId);
  assertEquals(customer.barber_lead_id, apifyId);
});

Deno.test("acknowledges topics it does not sync", async () => {
  const db = memory();
  const body = JSON.stringify({ id: 1 });
  const response = await handleShopifyWebhook(
    post(body, {
      "x-shopify-hmac-sha256": await sign(body),
      "x-shopify-topic": "orders/fulfilled",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, ignored: true });
  assertEquals(db.created(), 0);
});

Deno.test("records one conversion for a recent outreach recipient and ignores the retry", async () => {
  const db = memory({ recentEmails: ["owner@example-barber.test"] });
  const body = JSON.stringify({
    id: 90,
    email: "owner@example-barber.test",
    financial_status: "paid",
    processed_at: "2026-09-24T09:30:00Z",
    currency: "SEK",
    total_price: "148.00",
    shipping_address: { country_code: "SE", company: "Testsalong AB" },
  });
  const headers = {
    "x-shopify-hmac-sha256": await sign(body),
    "x-shopify-topic": "orders/create",
  };
  assertEquals((await handleShopifyWebhook(post(body, headers), { secret, createStore: db.createStore })).status, 200);
  assertEquals((await handleShopifyWebhook(post(body, headers), { secret, createStore: db.createStore })).status, 200);
  assertEquals(db.conversions.size, 1);
  const conversion = db.conversions.get("90");
  assertOk(conversion);
  assertEquals(conversion.amount, "148.00");
  assertEquals(conversion.currency, "SEK");
  assertEquals(conversion.barberId, barberId);
  assertEquals(conversion.organizationId, orgId);
  assertEquals(db.barberStatus.get(barberId), "customer");
  assertEquals(db.orgStatus.get(orgId), "customer");
});

Deno.test("does not convert an order when no outreach send is inside 90 days", async () => {
  const db = memory();
  const body = JSON.stringify({
    id: 91,
    email: "owner@example-barber.test",
    financial_status: "paid",
    processed_at: "2026-09-24T09:30:00Z",
    currency: "EUR",
    total_price: "148.00",
  });
  const response = await handleShopifyWebhook(
    post(body, {
      "x-shopify-hmac-sha256": await sign(body),
      "x-shopify-topic": "orders/paid",
    }),
    { secret, createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(db.conversions.size, 0);
  assertEquals(db.barberStatus.get(barberId), undefined);
});

Deno.test("upserts orders/updated and customers/update on the same ids", async () => {
  const db = memory();
  const orderBody = JSON.stringify({
    id: 92,
    email: "desk@frisorsalong.se",
    financial_status: "pending",
    currency: "SEK",
    total_price: "20.00",
  });
  const updated = orderBody.replace('"financial_status":"pending"', '"financial_status":"paid","processed_at":"2026-09-24T11:00:00Z"');
  assertEquals((await handleShopifyWebhook(post(orderBody, {
    "x-shopify-hmac-sha256": await sign(orderBody),
    "x-shopify-topic": "orders/updated",
  }), { secret, createStore: db.createStore })).status, 200);
  assertEquals((await handleShopifyWebhook(post(updated, {
    "x-shopify-hmac-sha256": await sign(updated),
    "x-shopify-topic": "orders/updated",
  }), { secret, createStore: db.createStore })).status, 200);
  assertEquals(db.orders.size, 1);
  assertEquals(db.orders.get("92")?.financial_status, "paid");
  assertEquals(db.orders.get("92")?.organization_id, orgId);

  const customerBody = JSON.stringify({
    id: 93,
    email: "owner@example-barber.test",
    first_name: "Bo",
    last_name: "Ek",
  });
  assertEquals((await handleShopifyWebhook(post(customerBody, {
    "x-shopify-hmac-sha256": await sign(customerBody),
    "x-shopify-topic": "customers/update",
  }), { secret, createStore: db.createStore })).status, 200);
  assertEquals(db.customers.get("93")?.barber_id, barberId);
  assertEquals(db.orders.size, 1);
});
