// Finance Gateway. Erik authenticates with his agent token. Fortnox credentials
// stay in Supabase secrets and finance_oauth_tokens. Deploy only after review:
//   supabase functions deploy finance-gateway --no-verify-jwt
// There is no Supabase JWT on these calls. See README.md.
import { createFortnoxClient, DEFAULT_FORTNOX_REDIRECT_URI } from "./fortnox.ts";
import { handleFinanceGateway } from "./handler.ts";
import { createServiceRoleClient, createSupabaseFinanceStore } from "./store.ts";

function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({
    source: event.source ?? null,
    agentId: event.agentId ?? null,
    decision: event.decision ?? null,
    reason: event.reason ?? null,
    path: event.path ?? null,
    method: event.method ?? null,
    fortnoxStatus: event.fortnoxStatus ?? null,
    dryRun: event.dryRun ?? null,
    requestId: event.requestId ?? null,
  }));
}

Deno.serve((req) => {
  try {
    return handleFinanceGateway(req, {
      adminToken: Deno.env.get("FINANCE_ADMIN_TOKEN") ?? "",
      redirectUri: Deno.env.get("FORTNOX_REDIRECT_URI") || DEFAULT_FORTNOX_REDIRECT_URI,
      expectedOauthState: Deno.env.get("FORTNOX_OAUTH_STATE") ?? "",
      store: createSupabaseFinanceStore(createServiceRoleClient()),
      fortnox: createFortnoxClient({
        clientId: Deno.env.get("FORTNOX_CLIENT_ID") ?? "",
        clientSecret: Deno.env.get("FORTNOX_CLIENT_SECRET") ?? "",
      }),
      now: () => new Date(),
      log,
    });
  } catch {
    return Promise.resolve(new Response(JSON.stringify({
      ok: false,
      decision: "error",
      reason: "server_misconfigured",
      fortnoxCalled: false,
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
  }
});
