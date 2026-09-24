// Wholesale inquiry receiver. Deploy only after review:
//   supabase functions deploy wholesale-inquiry --no-verify-jwt
// The theme posts JSON here, then the Shopify contact form still submits
// and sends the shop email. JWT verification stays off because the browser
// cannot send a Supabase JWT. CORS is limited to the storefront origin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { handleWholesaleInquiry, type WholesaleApplication } from "../_shared/wholesale.ts";

function createStore() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("missing supabase env");
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async insertApplication(row: WholesaleApplication) {
      const { error } = await client.from("wholesale_applications").insert({
        shop_name: row.shop_name,
        contact_name: row.contact_name,
        email: row.email,
        phone: row.phone,
        country: row.country,
        org_number: row.org_number,
        website: row.website,
        business_type: row.business_type,
        message: row.message,
        locale: row.locale,
        source: row.source,
        consent_status: row.consent_status,
        metadata: row.metadata,
      });
      if (error) {
        throw new Error("application insert failed");
      }
    },
    async upsertContact(row: WholesaleApplication) {
      const { data, error } = await client.rpc("upsert_contact", {
        p_email: row.email,
        p_full_name: row.contact_name,
        p_phone: row.phone,
        p_whatsapp: row.phone,
        p_preferred_language: row.locale,
        p_consent_status: row.consent_status,
        p_source_key: row.source,
        p_tags: ["wholesale_lead"],
      });
      if (error) {
        throw new Error("contact upsert failed");
      }
      return data ? String(data) : null;
    },
  };
}

const hits = new Map<string, number[]>();

function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({
    ok: event.ok ?? null,
    accepted: event.accepted ?? null,
  }));
}

Deno.serve((req) =>
  handleWholesaleInquiry(req, {
    createStore,
    hits,
    log,
  })
);
