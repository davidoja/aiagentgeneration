import type { ArchiveUpload, FortnoxClient, FortnoxResult, RefreshResult } from "./types.ts";

const TOKEN_URL = "https://apps.fortnox.se/oauth-v1/token";
const API_ORIGIN = "https://api.fortnox.se";

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
