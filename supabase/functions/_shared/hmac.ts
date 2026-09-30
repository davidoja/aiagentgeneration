const textEncoder = new TextEncoder();

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    const left = i < a.length ? a[i] : 0;
    const right = i < b.length ? b[i] : 0;
    mismatch |= left ^ right;
  }
  return mismatch === 0;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function signRawBody(secret: string, rawBody: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(rawBody));
  return new Uint8Array(mac);
}

// Shopify signs the raw request body with HMAC-SHA256 and base64-encodes it
// in X-Shopify-Hmac-Sha256. Compare the MAC bytes, not a re-serialized JSON
// document. A missing or blank header is rejected before any compare.
export async function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader || !secret) {
    return false;
  }
  const provided = decodeBase64(hmacHeader.trim());
  const expected = await signRawBody(secret, rawBody);
  if (!provided) {
    return false;
  }
  return timingSafeEqualBytes(expected, provided);
}
