import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import type { ConversionInput, PartyQuery, SyncStore } from "../_shared/handler.ts";
import type { CustomerRecord, OrderRecord } from "../_shared/map.ts";
import type { PartyMatch } from "../_shared/match.ts";

function customerPayload(row: CustomerRecord) {
  return {
    shopify_customer_id: row.shopify_customer_id,
    email: row.email,
    customer_name: row.customer_name,
    company_name: row.company_name,
    country: row.country,
    contact_id: row.contact_id,
    barber_id: row.barber_id,
    organization_id: row.organization_id,
    barber_lead_id: row.barber_lead_id,
    shopify_created_at: row.shopify_created_at,
    shopify_updated_at: row.shopify_updated_at,
    raw_payload: row.raw_payload,
  };
}

function orderPayload(row: OrderRecord) {
  return {
    shopify_order_id: row.shopify_order_id,
    order_number: row.order_number,
    order_name: row.order_name,
    shopify_customer_id: row.shopify_customer_id,
    shopify_created_at: row.shopify_created_at,
    paid_at: row.paid_at,
    financial_status: row.financial_status,
    currency: row.currency,
    total_price: row.total_price,
    subtotal_price: row.subtotal_price,
    total_tax: row.total_tax,
    total_discounts: row.total_discounts,
    customer_email: row.customer_email,
    customer_name: row.customer_name,
    company_name: row.company_name,
    shipping_country: row.shipping_country,
    billing_country: row.billing_country,
    line_items: row.line_items,
    raw_payload: row.raw_payload,
    contact_id: row.contact_id,
    barber_id: row.barber_id,
    organization_id: row.organization_id,
    barber_lead_id: row.barber_lead_id,
  };
}

function asParty(row: Record<string, unknown> | null): PartyMatch {
  return {
    contactId: row?.contact_id ? String(row.contact_id) : null,
    barberId: row?.barber_id ? String(row.barber_id) : null,
    organizationId: row?.organization_id ? String(row.organization_id) : null,
    apifyLeadId: row?.apify_lead_id ? String(row.apify_lead_id) : null,
    reason: row?.match_reason === "email" || row?.match_reason === "domain" || row?.match_reason === "company"
      ? row.match_reason
      : "none",
  };
}

export function createSupabaseStore(client: SupabaseClient): SyncStore {
  return {
    async matchParty(query: PartyQuery) {
      const { data, error } = await client.rpc("match_shopify_party", {
        p_email: query.email,
        p_company: query.company,
        p_country: query.country,
      });
      if (error) {
        throw new Error("party match failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      return asParty(row ?? null);
    },

    async upsertContact(email, fullName) {
      const { data, error } = await client.rpc("upsert_contact", {
        p_email: email,
        p_full_name: fullName,
        p_consent_status: "unknown",
        p_source_key: "shopify",
        p_tags: ["shopify_customer"],
      });
      if (error) {
        throw new Error("contact upsert failed");
      }
      return data ? String(data) : null;
    },

    async upsertCustomer(row) {
      const { error } = await client.rpc("upsert_shopify_customer", {
        p: customerPayload(row),
      });
      if (error) {
        throw new Error("customer upsert failed");
      }
    },

    async upsertOrder(row) {
      const { error } = await client.rpc("upsert_shopify_order", {
        p: orderPayload(row),
      });
      if (error) {
        throw new Error("order upsert failed");
      }
    },

    async recordConversion(input: ConversionInput) {
      const { data, error } = await client.rpc("record_shopify_outreach_conversion", {
        p_email: input.email,
        p_order_id: input.shopifyOrderId,
        p_amount: input.amount,
        p_currency: input.currency,
        p_barber_id: input.barberId,
        p_organization_id: input.organizationId,
      });
      if (error) {
        throw new Error("conversion record failed");
      }
      return data === true;
    },
  };
}

export function createServiceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("missing supabase env");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
