import { assertEquals, assertOk } from "./assert.ts";
import { BLOCKED_ACCOUNT_RANGES, blockedAccountNumbers } from "./blocked_accounts.ts";
import { assessWrite, firstOfPreviousCalendarMonth, periodBounds, stockholmDate } from "./policy.ts";

Deno.test("blocked account boundaries match the seeded ranges", () => {
  const blocked = new Set(blockedAccountNumbers());
  assertEquals(blocked.size, 988);
  const blockedSamples = [1480, 1630, 1650, 2010, 2099, 2393, 2510, 2519, 2650, 2710, 2799, 2890, 2893, 2898, 7000, 7699, 8910, 8999];
  const openSamples = [1479, 1930, 2100, 2392, 2394, 2509, 2520, 2649, 2651, 2709, 2800, 2889, 2891, 2899, 3001, 6999, 7700, 8909, 9000];
  for (const account of blockedSamples) {
    assertEquals(blocked.has(account), true, String(account));
  }
  for (const account of openSamples) {
    assertEquals(blocked.has(account), false, String(account));
  }
});

Deno.test("period bounds use Stockholm today, the previous month, and the financial year", () => {
  assertEquals(stockholmDate(new Date("2026-09-24T10:00:00.000Z")), "2026-09-24");
  assertEquals(stockholmDate(new Date("2026-01-15T23:30:00.000Z")), "2026-01-16");
  assertEquals(firstOfPreviousCalendarMonth("2026-09-24"), "2026-08-01");
  assertEquals(firstOfPreviousCalendarMonth("2026-01-16"), "2025-12-01");
  const bounds = periodBounds("2026-09-24", "2026-01-01", "2026-12-31");
  assertEquals(bounds, { earliest: "2026-08-01", latest: "2026-09-24" });
  assertEquals(periodBounds("2026-09-24", null, null), null);
});

Deno.test("a reclassification above the threshold needs an amount approval and an ASK account needs its own", () => {
  const blocked = new Set(blockedAccountNumbers());
  const over = assessWrite({
    writeClass: "voucher",
    category: "accrual",
    transactionDate: "2026-09-01",
    body: {
      Voucher: {
        TransactionDate: "2026-09-01",
        VoucherRows: [
          { Account: 1930, Debit: 15000, Credit: 0 },
          { Account: 2990, Debit: 0, Credit: 15000 },
        ],
      },
    },
    blocked,
    thresholdSek: 10000,
    today: "2026-09-24",
    financialYearStart: "2026-01-01",
    financialYearEnd: "2026-12-31",
    requireBodyDate: true,
  });
  assertEquals(over.ok, true);
  if (over.ok) {
    assertEquals(over.needs, [{ kind: "amount_threshold", category: "accrual", amount: 15000 }]);
  }

  const ask = assessWrite({
    writeClass: "supplier_invoice_payment",
    category: "payment",
    transactionDate: "2026-09-01",
    body: { SupplierInvoicePayment: { Amount: 400, PaymentDate: "2026-09-01", ModeOfPaymentAccount: 1630 } },
    blocked,
    thresholdSek: 10000,
    today: "2026-09-24",
    financialYearStart: "2026-01-01",
    financialYearEnd: "2026-12-31",
    requireBodyDate: true,
  });
  assertEquals(ask.ok, true);
  if (ask.ok) {
    assertEquals(ask.needs, [{ kind: "ask_account", accounts: [1630] }]);
  }
});

Deno.test("the migration seeds every blocked range and forces RLS", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260924210000_finance_gateway.sql", import.meta.url));
  for (const range of BLOCKED_ACCOUNT_RANGES) {
    assertOk(sql.includes(`generate_series(${range.from}, ${range.to})`), `${range.from}-${range.to}`);
    assertOk(sql.includes(`'${range.reason}'`), range.reason);
  }
  assertOk(sql.includes("force row level security"));
  assertOk(sql.includes("revoke all on table public.finance_oauth_tokens from public, anon, authenticated"));
  assertOk(sql.includes("grant select, insert on table public.finance_audit_log to service_role"));
  assertOk(!sql.includes("eyJ"));
  assertOk(!/refresh_token\s*=\s*'/.test(sql));
});
