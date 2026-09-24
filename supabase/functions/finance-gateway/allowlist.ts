// Explicit Fortnox API v3 surface. A route that is not listed here does not exist.
// Paths follow https://api.fortnox.se/apidocs (bookkeep is PUT, file connections
// and archive upload are POST, monitoring resources are GET).

export type WriteClass =
  | "voucher"
  | "invoice_payment"
  | "supplier_invoice_payment"
  | "voucher_file"
  | "supplier_invoice_file"
  | "archive";

export type AllowedRoute = {
  method: "GET" | "POST" | "PUT";
  kind: "read" | "write";
  writeClass: WriteClass | null;
  pattern: RegExp;
};

const NUM = "[0-9]{1,12}";
const SERIES = "[A-Za-z][A-Za-z0-9]{0,9}";
const ID = "[A-Za-z0-9_-]{1,64}";

function route(method: AllowedRoute["method"], kind: AllowedRoute["kind"], pattern: RegExp, writeClass: WriteClass | null = null): AllowedRoute {
  return { method, kind, pattern, writeClass };
}

export const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  route("POST", "write", /^\/3\/vouchers$/, "voucher"),
  route("POST", "write", /^\/3\/invoicepayments$/, "invoice_payment"),
  route("PUT", "write", new RegExp(`^\\/3\\/invoicepayments\\/${NUM}\\/bookkeep$`), "invoice_payment"),
  route("POST", "write", /^\/3\/supplierinvoicepayments$/, "supplier_invoice_payment"),
  route("PUT", "write", new RegExp(`^\\/3\\/supplierinvoicepayments\\/${NUM}\\/bookkeep$`), "supplier_invoice_payment"),
  route("POST", "write", /^\/3\/voucherfileconnections$/, "voucher_file"),
  route("POST", "write", /^\/3\/supplierinvoicefileconnections$/, "supplier_invoice_file"),
  route("POST", "write", /^\/3\/archive$/, "archive"),

  route("GET", "read", /^\/3\/vouchers$/),
  route("GET", "read", new RegExp(`^\\/3\\/vouchers\\/sublist\\/${SERIES}$`)),
  route("GET", "read", new RegExp(`^\\/3\\/vouchers\\/${SERIES}\\/${NUM}$`)),
  route("GET", "read", /^\/3\/voucherseries$/),
  route("GET", "read", new RegExp(`^\\/3\\/voucherseries\\/${SERIES}$`)),
  route("GET", "read", /^\/3\/invoices$/),
  route("GET", "read", new RegExp(`^\\/3\\/invoices\\/${NUM}$`)),
  route("GET", "read", /^\/3\/supplierinvoices$/),
  route("GET", "read", new RegExp(`^\\/3\\/supplierinvoices\\/${NUM}$`)),
  route("GET", "read", /^\/3\/invoicepayments$/),
  route("GET", "read", new RegExp(`^\\/3\\/invoicepayments\\/${NUM}$`)),
  route("GET", "read", /^\/3\/supplierinvoicepayments$/),
  route("GET", "read", new RegExp(`^\\/3\\/supplierinvoicepayments\\/${NUM}$`)),
  route("GET", "read", /^\/3\/accounts$/),
  route("GET", "read", /^\/3\/accounts\/[0-9]{4}$/),
  route("GET", "read", /^\/3\/financialyears$/),
  route("GET", "read", new RegExp(`^\\/3\\/financialyears\\/${NUM}$`)),
  route("GET", "read", /^\/3\/customers$/),
  route("GET", "read", new RegExp(`^\\/3\\/customers\\/${ID}$`)),
  route("GET", "read", /^\/3\/suppliers$/),
  route("GET", "read", new RegExp(`^\\/3\\/suppliers\\/${ID}$`)),
  route("GET", "read", /^\/3\/inbox$/),
  route("GET", "read", new RegExp(`^\\/3\\/inbox\\/${ID}$`)),
  route("GET", "read", /^\/3\/archive$/),
  route("GET", "read", new RegExp(`^\\/3\\/archive\\/${ID}$`)),
  route("GET", "read", /^\/3\/companyinformation$/),
  route("GET", "read", /^\/3\/voucherfileconnections$/),
  route("GET", "read", new RegExp(`^\\/3\\/voucherfileconnections\\/${ID}$`)),
  route("GET", "read", /^\/3\/supplierinvoicefileconnections$/),
  route("GET", "read", new RegExp(`^\\/3\\/supplierinvoicefileconnections\\/${ID}$`)),
];

const SETTINGS_FRAGMENTS = [
  "settings",
  "modesofpayment",
  "predefinedaccount",
  "accountchart",
  "companysettings",
];

const BANK_FRAGMENTS = [
  "bank",
  "paymentorder",
  "payment-order",
  "directdebit",
  "noxfinans",
  "approvalpayment",
];

export type RouteDecision =
  | { ok: true; route: AllowedRoute; path: string }
  | { ok: false; reason: "delete_forbidden" | "settings_forbidden" | "bank_payment_forbidden" | "not_allowlisted" | "invalid_path" };

export function normalizeFortnoxPath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 200) {
    return null;
  }
  let path = input.trim();
  if (path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("%") || path.includes("@")) {
    return null;
  }
  try {
    path = decodeURI(path);
  } catch {
    return null;
  }
  if (path.includes("%") || path.includes("..") || path.includes("//") || path.includes(" ")) {
    return null;
  }
  if (!path.startsWith("/3/")) {
    return null;
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  if (!/^\/3\/[A-Za-z0-9/_-]+$/.test(path)) {
    return null;
  }
  return path;
}

export function matchRoute(method: string, path: string): RouteDecision {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "DELETE") {
    return { ok: false, reason: "delete_forbidden" };
  }
  const normalizedPath = normalizeFortnoxPath(path);
  if (!normalizedPath) {
    return { ok: false, reason: "invalid_path" };
  }
  const lower = normalizedPath.toLowerCase();
  if (SETTINGS_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return { ok: false, reason: "settings_forbidden" };
  }
  if (BANK_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return { ok: false, reason: "bank_payment_forbidden" };
  }
  if (normalizedMethod !== "GET" && normalizedMethod !== "POST" && normalizedMethod !== "PUT") {
    return { ok: false, reason: "not_allowlisted" };
  }
  const found = ALLOWED_ROUTES.find((candidate) => candidate.method === normalizedMethod && candidate.pattern.test(normalizedPath));
  if (!found) {
    return { ok: false, reason: "not_allowlisted" };
  }
  return { ok: true, route: found, path: normalizedPath };
}

const QUERY_KEYS = new Set([
  "lastmodified",
  "financialyear",
  "financialyeardate",
  "fromdate",
  "todate",
  "page",
  "limit",
  "offset",
  "sortby",
  "sortorder",
  "filter",
  "customernumber",
  "suppliernumber",
  "accountnumber",
]);

export function normalizeQuery(input: unknown): Record<string, string> | null {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (!QUERY_KEYS.has(name)) {
      return null;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }
    const text = String(value);
    if (!/^[A-Za-z0-9_ .:/-]{1,40}$/.test(text)) {
      return null;
    }
    query[name] = text;
  }
  return query;
}
