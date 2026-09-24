import { assertEquals, assertNotEquals, assertOk } from "./assert.ts";
import { handleShopifyWebhook, type SyncStore } from "./handler.ts";
import type { CustomerRecord, OrderRecord } from "./map.ts";
import type { BarberLead } from "./match.ts";

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

function memory(leads: BarberLead[]) {
  const orders = new Map<string, OrderRecord>();
  const customers = new Map<string, CustomerRecord>();
  let created = 0;
  const store: SyncStore = {
    findCandidates() {
      return Promise.resolve(leads);
    },
    upsertCustomer(row) {
      const prev = customers.get(row.shopify_customer_id);
      customers.set(row.shopify_customer_id, {
        ...prev,
        ...row,
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
        barber_lead_id: row.barber_lead_id ?? prev?.barber_lead_id ?? null,
      });
      return Promise.resolve();
    },
  };
  return {
    orders,
    customers,
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

const leads: BarberLead[] = [
  {
    id: "lead-salon",
    domain: "frisorsalong.se",
    emails: ["owner@example-barber.test"],
    company_domain_emails: ["faktura@frisorsalong.se"],
  },
  {
    id: "lead-gmail",
    domain: "gmail.com",
    emails: ["anna@gmail.com"],
    company_domain_emails: [],
  },
];

Deno.test("rejects a webhook with no HMAC header and does not touch the store", async () => {
  const db = memory(leads);
  const response = await handleShopifyWebhook(post("{}"), {
    secret,
    createStore: db.createStore,
  });
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "missing hmac" });
  assertEquals(db.created(), 0);
});

Deno.test("rejects an invalid HMAC and does not touch the store", async () => {
  const db = memory(leads);
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
  const db = memory(leads);
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
  assertEquals(order.barber_lead_id, "lead-salon");
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
  assertEquals(db.customers.get("706405506930370084")?.barber_lead_id, "lead-salon");
});

Deno.test("does not domain-match a free-mail customer", async () => {
  const db = memory(leads);
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
  assertEquals(db.orders.get("55")?.barber_lead_id, null);
  assertEquals(db.orders.get("55")?.paid_at, "2026-09-24T09:30:00.000Z");
});

Deno.test("upserts customers/create without writing an order", async () => {
  const db = memory(leads);
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
  assertEquals(customer.barber_lead_id, "lead-salon");
});

Deno.test("acknowledges topics it does not sync", async () => {
  const db = memory(leads);
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
