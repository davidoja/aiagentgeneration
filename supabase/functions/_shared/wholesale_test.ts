import { assertEquals, assertOk } from "./assert.ts";
import {
  allowWholesaleIp,
  applicationFromContact,
  handleWholesaleInquiry,
  WHOLESALE_MAX_PER_WINDOW,
  WHOLESALE_ORIGIN,
  type WholesaleApplication,
  type WholesaleStore,
} from "./wholesale.ts";

const origin = { origin: WHOLESALE_ORIGIN };

function validContact() {
  return {
    Company: "Example Trade AB",
    name: "Bo Ek",
    email: "Buyer@Example-Trade.test",
    phone: "+46700000000",
    "Country or market": "Sweden",
    "VAT or company number": "559999-0000",
    Website: "https://example-trade.test",
    "Business type": "Grossist",
    "Outlets supplied": "12",
    "Brands carried": "Example brand",
    body: "Planning a first order.",
    "Inquiry type": "Wholesale / distribution",
    "Submitted from": "brandsofsultan.com/pages/wholesale (sv)",
  };
}

function memory() {
  const applications: WholesaleApplication[] = [];
  const contacts: string[] = [];
  let created = 0;
  const store: WholesaleStore = {
    insertApplication(row) {
      applications.push(row);
      return Promise.resolve();
    },
    upsertContact(row) {
      contacts.push(row.email);
      return Promise.resolve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    },
  };
  return {
    applications,
    contacts,
    createStore() {
      created += 1;
      return store;
    },
    created: () => created,
  };
}

function post(body: unknown, headers: Record<string, string> = origin): Request {
  return new Request("https://example.test/wholesale-inquiry", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("accepts the live DistributorForm fields and calls the contact upsert", async () => {
  const db = memory();
  const response = await handleWholesaleInquiry(
    post({ contact: validContact(), company_website: "" }),
    { createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), WHOLESALE_ORIGIN);
  assertEquals(db.applications.length, 1);
  assertEquals(db.contacts, ["buyer@example-trade.test"]);
  const row = db.applications[0];
  assertEquals(row.shop_name, "Example Trade AB");
  assertEquals(row.contact_name, "Bo Ek");
  assertEquals(row.email, "buyer@example-trade.test");
  assertEquals(row.phone, "+46700000000");
  assertEquals(row.country, "Sweden");
  assertEquals(row.org_number, "559999-0000");
  assertEquals(row.website, "https://example-trade.test");
  assertEquals(row.business_type, "Grossist");
  assertEquals(row.message, "Planning a first order.");
  assertEquals(row.locale, "sv");
  assertEquals(row.source, "shopify_wholesale");
  assertEquals(row.consent_status, "legitimate_interest");
  assertEquals(row.metadata.outlets_supplied, "12");
  assertEquals(row.metadata.brands_carried, "Example brand");
});

Deno.test("rejects a missing required field or a bad email without writing", async () => {
  const db = memory();
  const missing = validContact();
  delete (missing as { email?: string }).email;
  const missingResponse = await handleWholesaleInquiry(
    post({ contact: missing, company_website: "" }),
    { createStore: db.createStore },
  );
  assertEquals(missingResponse.status, 400);
  assertEquals(db.created(), 0);

  const bad = await handleWholesaleInquiry(
    post({ contact: { ...validContact(), email: "not-an-email" }, company_website: "" }),
    { createStore: db.createStore },
  );
  assertEquals(bad.status, 400);
  assertEquals(db.created(), 0);
  assertEquals(applicationFromContact({ ...validContact(), email: "not-an-email" }), null);
});

Deno.test("drops a filled honeypot without writing", async () => {
  const db = memory();
  const response = await handleWholesaleInquiry(
    post({ contact: validContact(), company_website: "https://spam.test" }),
    { createStore: db.createStore },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  assertEquals(db.created(), 0);
});

Deno.test("allows CORS only for the storefront origin", async () => {
  const db = memory();
  const allowed = await handleWholesaleInquiry(
    new Request("https://example.test/wholesale-inquiry", { method: "OPTIONS", headers: origin }),
    { createStore: db.createStore },
  );
  assertEquals(allowed.status, 204);
  assertEquals(allowed.headers.get("access-control-allow-origin"), WHOLESALE_ORIGIN);
  assertEquals(db.created(), 0);

  const blocked = await handleWholesaleInquiry(
    post({ contact: validContact(), company_website: "" }, { origin: "https://evil.example" }),
    { createStore: db.createStore },
  );
  assertEquals(blocked.status, 403);
  assertEquals(blocked.headers.get("access-control-allow-origin"), null);
  assertEquals(db.created(), 0);
});

Deno.test("rate limits repeated posts from one address", () => {
  const hits = new Map<string, number[]>();
  const now = 1_700_000_000_000;
  for (let i = 0; i < WHOLESALE_MAX_PER_WINDOW; i++) {
    assertEquals(allowWholesaleIp("203.0.113.10", now + i, hits), true);
  }
  assertEquals(allowWholesaleIp("203.0.113.10", now + 10, hits), false);
  assertEquals(allowWholesaleIp("203.0.113.11", now + 10, hits), true);
  assertOk(hits.get("203.0.113.10"));
});
