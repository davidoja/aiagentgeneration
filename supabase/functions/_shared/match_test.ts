import { assertEquals } from "./assert.ts";
import { isFreeMailDomain, matchBarberLead, matchParty, type BarberLead, type PartyCatalog } from "./match.ts";

const salon: BarberLead = {
  id: "lead-salon",
  domain: "https://www.frisorsalong.se/kontakt",
  emails: ["owner@example-barber.test"],
  company_domain_emails: ["faktura@frisorsalong.se"],
};

const other: BarberLead = {
  id: "lead-other",
  domain: "other-barber.se",
  emails: ["hello@other-barber.se"],
  company_domain_emails: [],
};

Deno.test("matches a barber by exact email before domain", () => {
  const result = matchBarberLead("Owner@example-barber.test", [other, salon]);
  assertEquals(result, { leadId: "lead-salon", reason: "email" });
});

Deno.test("matches a barber by company email when the personal list does not contain it", () => {
  const lead: BarberLead = {
    id: "lead-company",
    domain: "salong.example",
    emails: [],
    company_domain_emails: "orders@salong.example, desk@salong.example",
  };
  const result = matchBarberLead("orders@salong.example", [lead]);
  assertEquals(result, { leadId: "lead-company", reason: "email" });
});

Deno.test("matches by email domain when no exact email exists", () => {
  const result = matchBarberLead("desk@frisorsalong.se", [salon, other]);
  assertEquals(result, { leadId: "lead-salon", reason: "domain" });
});

Deno.test("matches by a company-email domain when the domain column differs", () => {
  const lead: BarberLead = {
    id: "lead-domain-email",
    domain: "old-name.example",
    emails: ["personal@gmail.com"],
    company_domain_emails: [{ email: "hej@nyasalong.se" }],
  };
  const result = matchBarberLead("kund@nyasalong.se", [lead]);
  assertEquals(result, { leadId: "lead-domain-email", reason: "domain" });
});

Deno.test("does not domain-match free-mail addresses", () => {
  const gmailLead: BarberLead = {
    id: "lead-gmail",
    domain: "gmail.com",
    emails: ["anna@gmail.com"],
    company_domain_emails: [],
  };
  const free = [
    "other@gmail.com",
    "other@gmx.de",
    "other@web.de",
    "other@outlook.com",
    "other@hotmail.com",
    "other@yahoo.com",
    "other@icloud.com",
    "other@t-online.de",
    "other@googlemail.com",
    "other@me.com",
  ];
  for (const email of free) {
    const result = matchBarberLead(email, [gmailLead, salon]);
    assertEquals(result.leadId, null, email);
    assertEquals(result.reason, "none", email);
    assertEquals(isFreeMailDomain(email.split("@")[1]), true, email);
  }
});

Deno.test("still matches an exact free-mail address on a lead", () => {
  const gmailLead: BarberLead = {
    id: "lead-gmail",
    domain: "gmail.com",
    emails: ["anna@gmail.com"],
    company_domain_emails: [],
  };
  const result = matchBarberLead("Anna@Gmail.com", [gmailLead]);
  assertEquals(result, { leadId: "lead-gmail", reason: "email" });
});

Deno.test("does not treat a subdomain as the lead's domain", () => {
  const result = matchBarberLead("orders@shop.frisorsalong.se", [salon]);
  assertEquals(result, { leadId: null, reason: "none" });
});

Deno.test("returns no match when nothing lines up", () => {
  const result = matchBarberLead("buyer@unknown-salon.test", [salon, other]);
  assertEquals(result, { leadId: null, reason: "none" });
  assertEquals(matchBarberLead(null, [salon]), { leadId: null, reason: "none" });
  assertEquals(matchBarberLead("not-an-email", [salon]), { leadId: null, reason: "none" });
});

Deno.test("returns no match when two leads share the same email", () => {
  const duplicate: BarberLead = { ...salon, id: "lead-duplicate" };
  const result = matchBarberLead("owner@example-barber.test", [salon, duplicate]);
  assertEquals(result, { leadId: null, reason: "none" });
});

const party: PartyCatalog = {
  contacts: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "buyer@example-barber.test",
    organizationIds: [],
  }],
  barbers: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@example-barber.test",
      organizationId: "22222222-2222-4222-8222-222222222222",
      name: "Testsalong AB",
      country: "SE",
    },
    {
      id: "11111111-1111-4111-8111-111111111112",
      email: null,
      organizationId: "22222222-2222-4222-8222-222222222223",
      name: "Andra Salongen",
      country: "DE",
    },
  ],
  organizations: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "Testsalong AB",
      domains: ["https://www.frisorsalong.se/kontakt"],
      countryCodes: ["SE"],
    },
    {
      id: "22222222-2222-4222-8222-222222222223",
      displayName: "Andra Salongen",
      domains: ["andra.example"],
      countryCodes: ["DE"],
    },
    {
      id: "22222222-2222-4222-8222-222222222224",
      displayName: "Testsalong AB",
      domains: ["gmail.com"],
      countryCodes: ["SE"],
    },
  ],
  leads: [salon],
};

Deno.test("matches a contact or barber by exact email before domain", () => {
  const barber = matchParty("Owner@example-barber.test", "Other Name", "DE", party);
  assertEquals(barber.reason, "email");
  assertEquals(barber.barberId, "11111111-1111-4111-8111-111111111111");
  assertEquals(barber.organizationId, "22222222-2222-4222-8222-222222222222");

  const contact = matchParty("buyer@example-barber.test", null, null, party);
  assertEquals(contact.reason, "email");
  assertEquals(contact.contactId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assertEquals(contact.barberId, null);
});

Deno.test("matches an organization by normalize_domain and skips free mail", () => {
  const hit = matchParty("desk@frisorsalong.se", null, null, party);
  assertEquals(hit.reason, "domain");
  assertEquals(hit.organizationId, "22222222-2222-4222-8222-222222222222");
  assertEquals(hit.barberId, "11111111-1111-4111-8111-111111111111");

  const free = matchParty("other@gmail.com", null, null, party);
  assertEquals(free.organizationId, null);
  assertEquals(free.reason, "none");
  assertEquals(matchParty("orders@shop.frisorsalong.se", null, null, party).organizationId, null);
});

Deno.test("matches one company name in one country and refuses an ambiguous name", () => {
  const hit = matchParty("buyer@unknown-salon.test", "Andra Salongen", "DE", party);
  assertEquals(hit.reason, "company");
  assertEquals(hit.barberId, "11111111-1111-4111-8111-111111111112");
  assertEquals(hit.organizationId, "22222222-2222-4222-8222-222222222223");

  const ambiguous = matchParty("buyer@unknown-salon.test", "Testsalong AB", "SE", party);
  assertEquals(ambiguous.reason, "none");
  assertEquals(ambiguous.barberId, null);
  assertEquals(ambiguous.organizationId, null);
});

Deno.test("returns no match when several leads share the domain", () => {
  const second: BarberLead = {
    id: "lead-second",
    domain: "frisorsalong.se",
    emails: [],
    company_domain_emails: [],
  };
  const result = matchBarberLead("desk@frisorsalong.se", [salon, second]);
  assertEquals(result, { leadId: null, reason: "none" });
});
