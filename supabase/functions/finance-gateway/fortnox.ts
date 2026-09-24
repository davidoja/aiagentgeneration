import type { ArchiveUpload, ClientCredentialsResult, ExchangeResult, FortnoxClient, FortnoxResult, RefreshResult } from "./types.ts";

const TOKEN_URL = "https://apps.fortnox.se/oauth-v1/token";
const API_ORIGIN = "https://api.fortnox.se";

export const DEFAULT_FORTNOX_REDIRECT_URI = "https://localhost/fortnox-callback";

const AUTH_CODE = /^[A-Za-z0-9._~-]{8,512}$/;
const OAUTH_STATE = /^[A-Za-z0-9._~-]{1,200}$/;
const TENANT_ID = /^[0-9]{1,20}$/;

export function isFortnoxTenantId(value: string): boolean {
  return TENANT_ID.test(value);
}

export type FortnoxHttp = (input: string, init: RequestInit) => Promise<Response>;

function basic(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export function createFortnoxClient(options: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FortnoxHttp;
}): FortnoxClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async refresh(refreshToken: string): Promise<RefreshResult> {
      if (!options.clientId || !options.clientSecret) {
        throw new Error("oauth_unconfigured");
      }
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "authorization": basic(options.clientId, options.clientSecret),
          "content-type": "application/x-www-form-urlencoded",
          "accept": "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      const payload = await readBody(response);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error("oauth_refresh_failed");
      }
      const record = payload as Record<string, unknown>;
      const accessToken = record.access_token;
      const nextRefresh = record.refresh_token;
      const expiresIn = record.expires_in;
      if (typeof accessToken !== "string" || typeof nextRefresh !== "string" || typeof expiresIn !== "number") {
        throw new Error("oauth_refresh_failed");
      }
      return { accessToken, refreshToken: nextRefresh, expiresIn };
    },

    async exchangeCode(input): Promise<ExchangeResult> {
      if (!options.clientId || !options.clientSecret) {
        throw new Error("oauth_unconfigured");
      }
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "authorization": basic(options.clientId, options.clientSecret),
          "content-type": "application/x-www-form-urlencoded",
          "accept": "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
        }),
      });
      const payload = await readBody(response);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error("oauth_exchange_failed");
      }
      const record = payload as Record<string, unknown>;
      const accessToken = record.access_token;
      const nextRefresh = record.refresh_token;
      const expiresIn = record.expires_in;
      const scope = typeof record.scope === "string" ? record.scope : "";
      if (typeof accessToken !== "string" || typeof nextRefresh !== "string" || typeof expiresIn !== "number" || expiresIn <= 0) {
        throw new Error("oauth_exchange_failed");
      }
      return { accessToken, refreshToken: nextRefresh, expiresIn, scope };
    },

    async clientCredentials(input): Promise<ClientCredentialsResult> {
      if (!options.clientId || !options.clientSecret) {
        throw new Error("oauth_unconfigured");
      }
      if (!isFortnoxTenantId(input.tenantId)) {
        throw new Error("oauth_unconfigured");
      }
      // Scope is omitted on purpose. Fortnox then uses the service-account
      // consent. https://www.fortnox.se/developer/authorization/get-access-token-using-client-credentials
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "authorization": basic(options.clientId, options.clientSecret),
          "content-type": "application/x-www-form-urlencoded",
          "accept": "application/json",
          "TenantId": input.tenantId,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
        }),
      });
      const payload = await readBody(response);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error("oauth_client_credentials_failed");
      }
      const record = payload as Record<string, unknown>;
      const accessToken = record.access_token;
      const expiresIn = record.expires_in;
      const scope = typeof record.scope === "string" ? record.scope : "";
      if (typeof accessToken !== "string" || accessToken.length < 8 || typeof expiresIn !== "number" || expiresIn <= 0) {
        throw new Error("oauth_client_credentials_failed");
      }
      return { accessToken, expiresIn, scope };
    },

    async request(input): Promise<FortnoxResult> {
      const url = new URL(API_ORIGIN + input.path);
      for (const [key, value] of Object.entries(input.query).sort(([a], [b]) => a.localeCompare(b))) {
        url.searchParams.set(key, value);
      }
      const headers = new Headers();
      headers.set("authorization", `Bearer ${input.accessToken}`);
      headers.set("accept", "application/json");
      let body: BodyInit | undefined;
      if (input.archive) {
        body = archiveBody(input.archive);
      } else if (input.method !== "GET" && input.body !== undefined && input.body !== null) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(input.body);
      }
      const response = await fetchImpl(url.toString(), {
        method: input.method,
        redirect: "error",
        headers,
        body,
      });
      return { status: response.status, body: await readBody(response) };
    },
  };
}

export function archiveBody(upload: ArchiveUpload): FormData {
  const form = new FormData();
  const bytes = upload.bytes.slice();
  form.set("file", new File([bytes], upload.fileName, { type: upload.contentType }));
  return form;
}

export function normalizeRedirectUri(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}`;
}

export function extractOAuthCallback(
  record: Record<string, unknown>,
  redirectUri: string,
): { code: string; state: string | null } | { error: "invalid_oauth" | "redirect_mismatch" | "server_misconfigured" | "oauth_state" } {
  const configured = normalizeRedirectUri(redirectUri);
  if (!configured) {
    return { error: "server_misconfigured" };
  }
  const redirectUrl = typeof record.redirectUrl === "string" ? record.redirectUrl.trim() : null;
  const codeField = typeof record.code === "string" ? record.code.trim() : null;
  const stateField = record.state === undefined || record.state === null ? null : record.state;
  if (stateField !== null && (typeof stateField !== "string" || !OAUTH_STATE.test(stateField))) {
    return { error: "invalid_oauth" };
  }
  const pasted = redirectUrl ?? (codeField && /^https?:\/\//i.test(codeField) ? codeField : null);
  if (pasted) {
    let url: URL;
    try {
      url = new URL(pasted);
    } catch {
      return { error: "invalid_oauth" };
    }
    const pastedBase = normalizeRedirectUri(`${url.origin}${url.pathname}`);
    if (!pastedBase) {
      return { error: "invalid_oauth" };
    }
    if (pastedBase !== configured) {
      return { error: "redirect_mismatch" };
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !AUTH_CODE.test(code)) {
      return { error: "invalid_oauth" };
    }
    if (state !== null && !OAUTH_STATE.test(state)) {
      return { error: "invalid_oauth" };
    }
    if (stateField && state && stateField !== state) {
      return { error: "oauth_state" };
    }
    return { code, state: state ?? stateField };
  }
  if (!codeField || !AUTH_CODE.test(codeField)) {
    return { error: "invalid_oauth" };
  }
  return { code: codeField, state: stateField };
}

export function scopesFrom(scope: string): string[] {
  return scope.split(/\s+/).filter((item) => /^[A-Za-z0-9_-]{1,64}$/.test(item));
}

export function decodeArchive(body: unknown): ArchiveUpload | null | "invalid" {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "invalid";
  }
  const record = body as Record<string, unknown>;
  const fileName = record.fileName;
  const contentType = record.contentType;
  const contentBase64 = record.contentBase64;
  if (typeof fileName !== "string" || typeof contentType !== "string" || typeof contentBase64 !== "string") {
    return "invalid";
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(fileName) || !/^[\w.+-]{1,40}\/[\w.+-]{1,40}$/.test(contentType)) {
    return "invalid";
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(contentBase64) || contentBase64.length > 12_000_000) {
    return "invalid";
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(contentBase64.replace(/\s/g, ""));
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return "invalid";
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 8_000_000) {
    return "invalid";
  }
  return { fileName, contentType, bytes };
}
