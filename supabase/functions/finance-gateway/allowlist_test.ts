import { assertEquals } from "./assert.ts";
import { matchRoute, normalizeQuery } from "./allowlist.ts";

Deno.test("allowlist accepts the bookkeeping surface and rejects everything else", () => {
  const allowed = [
    ["POST", "/3/vouchers"],
    ["POST", "/3/invoicepayments"],
    ["PUT", "/3/invoicepayments/42/bookkeep"],
    ["POST", "/3/supplierinvoicepayments"],
    ["PUT", "/3/supplierinvoicepayments/7/bookkeep"],
    ["POST", "/3/voucherfileconnections"],
    ["POST", "/3/supplierinvoicefileconnections"],
    ["POST", "/3/archive"],
    ["GET", "/3/vouchers"],
    ["GET", "/3/vouchers/sublist/A"],
    ["GET", "/3/vouchers/A/12"],
    ["GET", "/3/invoices/204"],
    ["GET", "/3/supplierinvoices"],
    ["GET", "/3/invoicepayments/3"],
    ["GET", "/3/supplierinvoicepayments"],
    ["GET", "/3/accounts/1930"],
    ["GET", "/3/financialyears"],
    ["GET", "/3/customers/1"],
    ["GET", "/3/suppliers/9"],
    ["GET", "/3/inbox"],
    ["GET", "/3/archive/abc"],
    ["GET", "/3/companyinformation"],
  ] as const;
  for (const [method, path] of allowed) {
    const decision = matchRoute(method, path);
    assertEquals(decision.ok, true, `${method} ${path}`);
  }

  assertEquals(matchRoute("DELETE", "/3/supplierinvoicepayments/15"), { ok: false, reason: "delete_forbidden" });
  assertEquals(matchRoute("GET", "/3/settings/company"), { ok: false, reason: "settings_forbidden" });
  assertEquals(matchRoute("POST", "/3/modesofpayments"), { ok: false, reason: "settings_forbidden" });
  assertEquals(matchRoute("PUT", "/3/supplierinvoices/9/approvalpayment"), { ok: false, reason: "bank_payment_forbidden" });
  assertEquals(matchRoute("POST", "/3/invoices"), { ok: false, reason: "not_allowlisted" });
  assertEquals(matchRoute("PUT", "/3/invoicepayments/5"), { ok: false, reason: "not_allowlisted" });
  assertEquals(matchRoute("POST", "/3/accounts"), { ok: false, reason: "not_allowlisted" });
  assertEquals(matchRoute("GET", "/3/vouchers/../settings/company"), { ok: false, reason: "invalid_path" });
  assertEquals(normalizeQuery({ fromdate: "2026-09-01", financialyear: 5 }), { fromdate: "2026-09-01", financialyear: "5" });
  assertEquals(normalizeQuery({ drop: "table" }), null);
});
