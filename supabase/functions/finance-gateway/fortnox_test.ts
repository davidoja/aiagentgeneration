import { assertEquals, assertOk } from "./assert.ts";
import { createFortnoxClient, decodeArchive } from "./fortnox.ts";

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
