// ASK accounts. Writes that touch one of these numbers are refused unless a
// matching one-time approval exists. Keep this list identical to the
// generate_series seeds in supabase/migrations/20260924210000_finance_gateway.sql.

export type BlockedRange = {
  from: number;
  to: number;
  reason: string;
};

export const BLOCKED_ACCOUNT_RANGES: readonly BlockedRange[] = [
  { from: 2010, to: 2099, reason: "equity" },
  { from: 2393, to: 2393, reason: "account_2393" },
  { from: 2510, to: 2519, reason: "tax_liability" },
  { from: 2710, to: 2799, reason: "payroll_tax" },
  { from: 2890, to: 2890, reason: "other_liability" },
  { from: 2893, to: 2893, reason: "other_liability" },
  { from: 2898, to: 2898, reason: "other_liability" },
  { from: 1480, to: 1480, reason: "account_1480" },
  { from: 1630, to: 1630, reason: "tax_account" },
  { from: 1650, to: 1650, reason: "vat_receivable" },
  { from: 2650, to: 2650, reason: "vat_liability" },
  { from: 7000, to: 7699, reason: "personnel_cost" },
  { from: 8910, to: 8999, reason: "appropriations_tax" },
];

export function blockedAccountNumbers(): number[] {
  const numbers: number[] = [];
  for (const range of BLOCKED_ACCOUNT_RANGES) {
    for (let account = range.from; account <= range.to; account += 1) {
      numbers.push(account);
    }
  }
  return numbers;
}
