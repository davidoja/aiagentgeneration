export type CustomerRecord = {
  shopify_customer_id: string;
  email: string | null;
  customer_name: string | null;
  company_name: string | null;
  country: string | null;
  barber_lead_id: string | null;
  shopify_created_at: string | null;
  shopify_updated_at: string | null;
  raw_payload: unknown;
};

export type OrderRecord = {
  shopify_order_id: string;
  order_number: number | null;
  order_name: string | null;
  shopify_customer_id: string | null;
  shopify_created_at: string | null;
  paid_at: string | null;
  financial_status: string | null;
  currency: string | null;
  total_price: string | null;
  subtotal_price: string | null;
  total_tax: string | null;
  total_discounts: string | null;
  customer_email: string | null;
  customer_name: string | null;
  company_name: string | null;
  shipping_country: string | null;
  billing_country: string | null;
  line_items: unknown[];
  raw_payload: unknown;
  barber_lead_id: string | null;
  customer: CustomerRecord | null;
};

type JsonRecord = Record<string, unknown>;

const PAID_STATUSES = new Set(["paid", "partially_paid", "partially_refunded"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shopify sample ids exceed Number.MAX_SAFE_INTEGER. Quote those integers
// before JSON.parse so the stored id matches the webhook byte for byte.
export function preserveShopifyBigInts(raw: string): string {
  return raw.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
}

export function asId(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) {
    return null;
  }
  return email;
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function asMoney(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function asCurrency(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function personName(record: JsonRecord | null): string | null {
  if (!record) {
    return null;
  }
  const first = typeof record.first_name === "string" ? record.first_name.trim() : "";
  const last = typeof record.last_name === "string" ? record.last_name.trim() : "";
  const combined = `${first} ${last}`.trim();
  if (combined) {
    return combined;
  }
  if (typeof record.name === "string" && record.name.trim() !== "") {
    return record.name.trim();
  }
  return null;
}

function companyFrom(...records: unknown[]): string | null {
  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }
    if (typeof record.company === "string" && record.company.trim() !== "") {
      return record.company.trim();
    }
  }
  return null;
}

function countryFrom(record: unknown): string | null {
  if (!isRecord(record)) {
    return null;
  }
  if (typeof record.country_code === "string" && record.country_code.trim() !== "") {
    return record.country_code.trim().toUpperCase();
  }
  if (typeof record.country === "string" && record.country.trim() !== "") {
    return record.country.trim();
  }
  return null;
}

function mapLineItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((item) => ({
    id: asId(item.id),
    product_id: asId(item.product_id),
    variant_id: asId(item.variant_id),
    title: typeof item.title === "string" ? item.title : null,
    sku: typeof item.sku === "string" ? item.sku : null,
    quantity: typeof item.quantity === "number" ? item.quantity : null,
    price: asMoney(item.price),
  }));
}

export function mapCustomer(payload: unknown): CustomerRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  const shopifyCustomerId = asId(payload.id);
  if (!shopifyCustomerId) {
    return null;
  }
  const address = isRecord(payload.default_address) ? payload.default_address : null;
  return {
    shopify_customer_id: shopifyCustomerId,
    email: asEmail(payload.email),
    customer_name: personName(payload),
    company_name: companyFrom(address),
    country: countryFrom(address),
    barber_lead_id: null,
    shopify_created_at: asTimestamp(payload.created_at),
    shopify_updated_at: asTimestamp(payload.updated_at),
    raw_payload: payload,
  };
}

export function mapOrder(payload: unknown, topic: string): OrderRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  const shopifyOrderId = asId(payload.id);
  if (!shopifyOrderId) {
    return null;
  }

  const customer = isRecord(payload.customer) ? payload.customer : null;
  const shipping = isRecord(payload.shipping_address) ? payload.shipping_address : null;
  const billing = isRecord(payload.billing_address) ? payload.billing_address : null;
  const defaultAddress = customer && isRecord(customer.default_address) ? customer.default_address : null;

  let financialStatus = typeof payload.financial_status === "string"
    ? payload.financial_status.trim().toLowerCase()
    : null;
  if (!financialStatus && topic === "orders/paid") {
    financialStatus = "paid";
  }

  const paid = topic === "orders/paid" || (financialStatus !== null && PAID_STATUSES.has(financialStatus));
  const paidAt = paid
    ? asTimestamp(payload.processed_at) ?? asTimestamp(payload.updated_at) ?? asTimestamp(payload.created_at)
    : null;

  const customerRecord = customer && asId(customer.id)
    ? mapCustomer({
      ...customer,
      email: customer.email ?? payload.email ?? payload.contact_email,
    })
    : null;

  return {
    shopify_order_id: shopifyOrderId,
    order_number: asInteger(payload.order_number),
    order_name: typeof payload.name === "string" ? payload.name : null,
    shopify_customer_id: customerRecord?.shopify_customer_id ?? null,
    shopify_created_at: asTimestamp(payload.created_at),
    paid_at: paidAt,
    financial_status: financialStatus,
    currency: asCurrency(payload.currency),
    total_price: asMoney(payload.total_price),
    subtotal_price: asMoney(payload.subtotal_price),
    total_tax: asMoney(payload.total_tax),
    total_discounts: asMoney(payload.total_discounts),
    customer_email: asEmail(payload.email) ?? asEmail(payload.contact_email) ?? customerRecord?.email ?? null,
    customer_name: customerRecord?.customer_name ?? personName(shipping) ?? personName(billing),
    company_name: companyFrom(shipping, billing, defaultAddress),
    shipping_country: countryFrom(shipping),
    billing_country: countryFrom(billing),
    line_items: mapLineItems(payload.line_items),
    raw_payload: payload,
    barber_lead_id: null,
    customer: customerRecord,
  };
}
