// Shopify webhook receiver. Deploy only after review:
//   supabase functions deploy shopify-webhook --no-verify-jwt
// JWT verification stays off because Shopify cannot send a Supabase JWT.
// X-Shopify-Hmac-Sha256 is the authentication check.
import { handleShopifyWebhook } from "../_shared/handler.ts";
import { createServiceRoleClient, createSupabaseStore } from "./store.ts";

function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({
    topic: event.topic ?? null,
    shopifyOrderId: event.shopifyOrderId ?? null,
    shopifyCustomerId: event.shopifyCustomerId ?? null,
    matched: event.matched ?? null,
    ignored: event.ignored ?? null,
    ok: event.ok ?? null,
  }));
}

Deno.serve((req) =>
  handleShopifyWebhook(req, {
    secret: Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "",
    createStore: () => createSupabaseStore(createServiceRoleClient()),
    log,
  })
);
