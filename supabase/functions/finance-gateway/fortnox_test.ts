import { assertEquals, assertOk } from "./assert.ts";
import { createFortnoxClient, decodeArchive, extractOAuthCallback, isFortnoxTenantId } from "./fortnox.ts";

Deno.test("refresh posts the rotated grant and API calls use only the bearer token", async () => {
  const seen: Array<{ url: string; authorization: string; body: string; contentType: string | null }> = [];
  const client = createFortnoxClient({
    clientId: "client-id-placeholder",
    clientSecret: "client-secret-placeholder",
    fetchImpl: (url, init) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
        ? init.body.toString()
        : "";
      seen.push({
        url,
        authorization: headers.get("authorization") ?? "",
        body,
        contentType: headers.get("content-type"),
      });
      if (url.includes("oauth-v1/token")) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "access-from-refresh-placeholder",
          refresh_token: "rotated-refresh-placeholder",
          expires_in: 3600,
          token_type: "bearer",
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ CompanyInformation: { CompanyName: "Example AB" } }), { status: 200 }));
    },
  });

  const refreshed = await client.refresh("current-refresh-placeholder");
  assertEquals(refreshed.refreshToken, "rotated-refresh-placeholder");
  assertEquals(seen[0].url, "https://apps.fortnox.se/oauth-v1/token");
  assertOk(seen[0].body.includes("grant_type=refresh_token"));
  assertOk(seen[0].body.includes("refresh_token=current-refresh-placeholder"));
  assertOk(seen[0].authorization.startsWith("Basic "));
  assertOk(!seen[0].url.includes("current-refresh-placeholder"));

  const archive = decodeArchive({
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    contentBase64: btoa("placeholder-pdf"),
  });
  if (archive === "invalid" || archive === null) {
    throw new Error("archive decode failed");
  }
  await client.request({
    accessToken: "access-from-refresh-placeholder",
    method: "GET",
    path: "/3/companyinformation",
    query: { limit: "1" },
    body: null,
    archive: null,
  });
  assertEquals(seen[1].url, "https://api.fortnox.se/3/companyinformation?limit=1");
  assertEquals(seen[1].authorization, "Bearer access-from-refresh-placeholder");
  assertOk(!seen[1].authorization.includes("client-secret-placeholder"));
  assertOk(!seen[1].body.includes("client-secret-placeholder"));

  await client.request({
    accessToken: "access-from-refresh-placeholder",
    method: "POST",
    path: "/3/archive",
    query: {},
    body: null,
    archive,
  });
  assertEquals(seen[2].url, "https://api.fortnox.se/3/archive");
  assertEquals(seen[2].contentType, null);
  assertOk(!seen[2].authorization.includes("client-secret-placeholder"));
});

Deno.test("authorization-code exchange posts the code to Fortnox and not into the URL", async () => {
  const seen: string[] = [];
  const client = createFortnoxClient({
    clientId: "client-id-placeholder",
    clientSecret: "client-secret-placeholder",
    fetchImpl: (url, init) => {
      const body = init.body instanceof URLSearchParams ? init.body.toString() : "";
      seen.push(`${url} ${body}`);
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "access-from-code-placeholder",
        refresh_token: "refresh-from-code-placeholder",
        expires_in: 3600,
        scope: "bookkeeping invoice",
        token_type: "bearer",
      }), { status: 200 }));
    },
  });
  const exchanged = await client.exchangeCode({
    code: "placeholder-auth-code",
    redirectUri: "https://localhost/fortnox-callback",
  });
  assertEquals(exchanged.scope, "bookkeeping invoice");
  assertOk(seen[0].startsWith("https://apps.fortnox.se/oauth-v1/token "));
  assertOk(seen[0].includes("grant_type=authorization_code"));
  assertOk(seen[0].includes("code=placeholder-auth-code"));
  assertOk(seen[0].includes("redirect_uri=https%3A%2F%2Flocalhost%2Ffortnox-callback"));
  assertOk(!seen[0].startsWith("https://apps.fortnox.se/oauth-v1/token?"));
  assertEquals(isFortnoxTenantId("123456"), true);
  assertEquals(isFortnoxTenantId(""), false);
  assertEquals(isFortnoxTenantId("12-34"), false);
  assertEquals(extractOAuthCallback({
    code: "https://localhost/fortnox-callback?code=callback-code-placeholder&state=state-placeholder",
  }, "https://localhost/fortnox-callback"), {
    code: "callback-code-placeholder",
    state: "state-placeholder",
  });
});

Deno.test("client credentials posts TenantId and grant_type without a refresh token", async () => {
  const seen: Array<{ url: string; authorization: string; tenantId: string | null; body: string }> = [];
  const client = createFortnoxClient({
    clientId: "client-id-placeholder",
    clientSecret: "client-secret-placeholder",
    fetchImpl: (url, init) => {
      const headers = new Headers(init.headers);
      const body = init.body instanceof URLSearchParams ? init.body.toString() : "";
      seen.push({
        url,
        authorization: headers.get("authorization") ?? "",
        tenantId: headers.get("TenantId"),
        body,
      });
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "access-from-client-credentials-placeholder",
        expires_in: 3600,
        token_type: "bearer",
        scope: "bookkeeping companyinformation",
      }), { status: 200 }));
    },
  });

  const minted = await client.clientCredentials({ tenantId: "123456" });
  assertEquals(minted.accessToken, "access-from-client-credentials-placeholder");
  assertEquals(minted.expiresIn, 3600);
  assertEquals("refreshToken" in minted, false);
  assertEquals(seen[0].url, "https://apps.fortnox.se/oauth-v1/token");
  assertEquals(seen[0].body, "grant_type=client_credentials");
  assertEquals(seen[0].tenantId, "123456");
  assertEquals(seen[0].authorization, `Basic ${btoa("client-id-placeholder:client-secret-placeholder")}`);
  assertOk(!seen[0].url.includes("123456"));
  assertOk(!seen[0].url.includes("client-secret-placeholder"));
  assertOk(!seen[0].body.includes("refresh_token"));
  assertOk(!seen[0].body.includes("scope="));

  const unconfigured = createFortnoxClient({
    clientId: "",
    clientSecret: "",
    fetchImpl: () => Promise.reject(new Error("fetch should not run")),
  });
  let message = "";
  try {
    await unconfigured.clientCredentials({ tenantId: "123456" });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(message, "oauth_unconfigured");
});
