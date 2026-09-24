import { assertEquals } from "./assert.ts";
import { timingSafeEqualBytes, verifyShopifyHmac } from "./hmac.ts";

const secret = "shpss_test_secret";
const raw = '{"id":123,"email":"owner@example-barber.test"}';
// Independent vector from Node crypto.createHmac('sha256', secret).update(raw).digest('base64').
const rawMac = "q0gYrgVo56dFGyyXZ6peagiVOW0m8lxRriZzKlvag1c=";
const spaced = "{ \"id\": 123 }";
const spacedMac = "kp93qSbMGck0wkuSetJZ+shcDhyQsbI+zjQi1DXOBMw=";
const compact = '{"id":123}';

Deno.test("accepts a valid Shopify HMAC over the raw body", async () => {
  assertEquals(await verifyShopifyHmac(raw, rawMac, secret), true);
});

Deno.test("rejects an HMAC that does not match the raw body", async () => {
  assertEquals(await verifyShopifyHmac(raw, spacedMac, secret), false);
  assertEquals(await verifyShopifyHmac(raw, "not-base64!!!", secret), false);
});

Deno.test("rejects a missing or blank HMAC header", async () => {
  assertEquals(await verifyShopifyHmac(raw, null, secret), false);
  assertEquals(await verifyShopifyHmac(raw, undefined, secret), false);
  assertEquals(await verifyShopifyHmac(raw, "", secret), false);
  assertEquals(await verifyShopifyHmac(raw, "   ", secret), false);
});

Deno.test("signs the raw bytes, not a re-serialized JSON body", async () => {
  assertEquals(await verifyShopifyHmac(spaced, spacedMac, secret), true);
  assertEquals(await verifyShopifyHmac(compact, spacedMac, secret), false);
  assertEquals(await verifyShopifyHmac(spaced, rawMac, secret), false);
});

Deno.test("compares MAC bytes in constant time, including unequal lengths", () => {
  const mac = new Uint8Array([1, 2, 3, 4]);
  assertEquals(timingSafeEqualBytes(mac, new Uint8Array([1, 2, 3, 4])), true);
  assertEquals(timingSafeEqualBytes(mac, new Uint8Array([1, 2, 3, 5])), false);
  assertEquals(timingSafeEqualBytes(mac, new Uint8Array([1, 2, 3])), false);
  assertEquals(timingSafeEqualBytes(mac, new Uint8Array([1, 2, 3, 4, 5])), false);
});
