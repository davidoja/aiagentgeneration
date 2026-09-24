import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import type { SyncStore } from "../_shared/handler.ts";
import type { CustomerRecord, OrderRecord } from "../_shared/map.ts";
import type { BarberLead } from "../_shared/match.ts";

function customerPayload(row: CustomerRecord) {
  return {
    shopify_customer_id: row.shopify_customer_id,
    email: row.email,
    customer_name: row.customer_name,
    company_name: row.company_name,
    country: row.country,
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
    barber_lead_id: row.barber_lead_id,
  };
}

export function createSupabaseStore(client: SupabaseClient): SyncStore {
  return {
    async findCandidates(email, domain) {
      const { data, error } = await client.rpc("shopify_barber_lead_candidates", {
        p_email: email,
        p_domain: domain,
      });
      if (error) {
        throw new Error("lead lookup failed");
      }
      const rows = Array.isArray(data) ? data : [];
      return rows.map((row: BarberLead) => ({
        id: String(row.id),
        domain: row.domain ?? null,
        emails: row.emails,
        company_domain_emails: row.company_domain_emails,
      }));
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
