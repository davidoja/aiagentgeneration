export const WHOLESALE_ORIGIN = "https://brandsofsultan.com";
export const WHOLESALE_WINDOW_MS = 10 * 60 * 1000;
export const WHOLESALE_MAX_PER_WINDOW = 5;

export type WholesaleApplication = {
  shop_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  country: string;
  org_number: string;
  website: string | null;
  business_type: string;
  message: string | null;
  locale: string | null;
  source: string;
  consent_status: string;
  metadata: Record<string, string | null>;
};

export type WholesaleStore = {
  insertApplication(row: WholesaleApplication): Promise<void>;
  upsertContact(row: WholesaleApplication): Promise<string | null>;
};

export type WholesaleDeps = {
  createStore: () => WholesaleStore;
  now?: () => number;
  hits?: Map<string, number[]>;
  log?: (event: Record<string, unknown>) => void;
};

type ContactFields = Record<string, string>;

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin === WHOLESALE_ORIGIN) {
    headers.set("access-control-allow-origin", WHOLESALE_ORIGIN);
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
    headers.set("vary", "origin");
  }
  return headers;
}

function json(body: Record<string, unknown>, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first.slice(0, 64);
    }
  }
  return req.headers.get("cf-connecting-ip")?.trim().slice(0, 64) || "unknown";
}

export function allowWholesaleIp(ip: string, now: number, hits: Map<string, number[]>): boolean {
  const recent = (hits.get(ip) ?? []).filter((stamp) => now - stamp < WHOLESALE_WINDOW_MS);
  if (recent.length >= WHOLESALE_MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function localeFromSubmitted(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\(([a-z]{2})\)\s*$/i);
  return match ? match[1].toLowerCase() : null;
}

export function applicationFromContact(contact: ContactFields): WholesaleApplication | null {
  const shopName = textField(contact.Company, 200);
  const contactName = textField(contact.name, 200);
  const emailRaw = textField(contact.email, 320);
  const country = textField(contact["Country or market"], 120);
  const orgNumber = textField(contact["VAT or company number"], 80);
  const businessType = textField(contact["Business type"], 80);
  if (!shopName || !contactName || !emailRaw || !country || !orgNumber || !businessType) {
    return null;
  }
  const email = emailRaw.toLowerCase();
  if (!isValidEmail(email)) {
    return null;
  }
  const submittedFrom = textField(contact["Submitted from"], 300);
  return {
    shop_name: shopName,
    contact_name: contactName,
    email,
    phone: textField(contact.phone, 40),
    country,
    org_number: orgNumber,
    website: textField(contact.Website, 300),
    business_type: businessType,
    message: textField(contact.body, 5000),
    locale: localeFromSubmitted(submittedFrom),
    source: "shopify_wholesale",
    consent_status: "legitimate_interest",
    metadata: {
      inquiry_type: textField(contact["Inquiry type"], 80),
      submitted_from: submittedFrom,
      outlets_supplied: textField(contact["Outlets supplied"], 80),
      brands_carried: textField(contact["Brands carried"], 500),
    },
  };
}

export async function handleWholesaleInquiry(req: Request, deps: WholesaleDeps): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin !== WHOLESALE_ORIGIN) {
    return json({ error: "origin not allowed" }, 403, null);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, origin);
  }

  const hits = deps.hits ?? new Map();
  const now = deps.now ? deps.now() : Date.now();
  if (!allowWholesaleIp(clientIp(req), now, hits)) {
    return json({ error: "rate limited" }, 429, origin);
  }

  const raw = await req.text();
  if (raw.length > 20000) {
    return json({ error: "invalid inquiry" }, 400, origin);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid inquiry" }, 400, origin);
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "invalid inquiry" }, 400, origin);
  }
  const record = body as Record<string, unknown>;
  const honeypot = typeof record.company_website === "string" ? record.company_website.trim() : "";
  if (honeypot) {
    deps.log?.({ ok: true, accepted: false });
    return json({ ok: true }, 200, origin);
  }
  const contact = record.contact;
  if (typeof contact !== "object" || contact === null) {
    return json({ error: "invalid inquiry" }, 400, origin);
  }
  const fields: ContactFields = {};
  for (const [key, value] of Object.entries(contact)) {
    if (typeof value === "string") {
      fields[key] = value;
    }
  }
  const application = applicationFromContact(fields);
  if (!application) {
    return json({ error: "invalid inquiry" }, 400, origin);
  }

  let store: WholesaleStore;
  try {
    store = deps.createStore();
  } catch {
    deps.log?.({ ok: false });
    return json({ error: "server misconfigured" }, 500, origin);
  }

  try {
    await store.insertApplication(application);
    await store.upsertContact(application);
  } catch {
    deps.log?.({ ok: false });
    return json({ error: "sync failed" }, 500, origin);
  }

  deps.log?.({ ok: true, accepted: true });
  return json({ ok: true }, 200, origin);
}
