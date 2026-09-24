import type { WriteClass } from "./allowlist.ts";
import type { ApprovalRecord } from "./types.ts";

export const THRESHOLD_CATEGORIES = ["reclassification", "accrual", "write_down"] as const;

export const CATEGORIES_BY_WRITE: Record<WriteClass, readonly string[]> = {
  voucher: ["routine", "reclassification", "accrual", "write_down"],
  invoice_payment: ["payment"],
  supplier_invoice_payment: ["payment"],
  voucher_file: ["file"],
  supplier_invoice_file: ["file"],
  archive: ["archive"],
};

const DATED_WRITES = new Set<WriteClass>(["voucher", "invoice_payment", "supplier_invoice_payment"]);

export function stockholmDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("stockholm date unavailable");
  }
  return `${year}-${month}-${day}`;
}

export function firstOfPreviousCalendarMonth(today: string): string {
  const [yearText, monthText] = today.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${String(previous.year).padStart(4, "0")}-${String(previous.month).padStart(2, "0")}-01`;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function periodBounds(today: string, financialYearStart: string | null, financialYearEnd: string | null): { earliest: string; latest: string } | null {
  if (!financialYearStart || !financialYearEnd || !isIsoDate(financialYearStart) || !isIsoDate(financialYearEnd)) {
    return null;
  }
  if (financialYearStart > financialYearEnd) {
    return null;
  }
  const earliest = financialYearStart > firstOfPreviousCalendarMonth(today) ? financialYearStart : firstOfPreviousCalendarMonth(today);
  const latest = financialYearEnd < today ? financialYearEnd : today;
  return { earliest, latest };
}

export function dateAllowed(date: string, bounds: { earliest: string; latest: string }): boolean {
  return isIsoDate(date) && date >= bounds.earliest && date <= bounds.latest;
}

export type MoneyLine = {
  account: number;
  amount: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, name: string): unknown {
  const found = Object.keys(record).find((key) => key.toLowerCase() === name);
  return found === undefined ? undefined : record[found];
}

function parseAmount(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value);
  }
  if (typeof value === "string" && /^-?\d+(\.\d{1,2})?$/.test(value.trim())) {
    return Math.abs(Number(value.trim()));
  }
  return null;
}

function parseAccount(value: unknown): number | null {
  const text = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{3}$/.test(text)) {
    return null;
  }
  return Number(text);
}

const ACCOUNT_FIELDS = ["account", "accountnumber", "modeofpaymentaccount", "balancingaccount"];

export type Extraction = {
  lines: MoneyLine[];
  invalidAccount: boolean;
  invalidAmount: boolean;
  dates: string[];
  invalidDate: boolean;
  currency: string | null;
  invalidCurrency: boolean;
};

export function extractWrite(body: unknown): Extraction {
  const lines: MoneyLine[] = [];
  const dates: string[] = [];
  let invalidAccount = false;
  let invalidAmount = false;
  let invalidDate = false;
  let currency: string | null = null;
  let invalidCurrency = false;

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const accounts: number[] = [];
    for (const name of ACCOUNT_FIELDS) {
      const raw = field(record, name);
      if (raw === undefined || raw === null || raw === "") {
        continue;
      }
      const parsed = parseAccount(raw);
      if (parsed === null) {
        invalidAccount = true;
      } else {
        accounts.push(parsed);
      }
    }
    const debit = parseAmount(field(record, "debit"));
    const credit = parseAmount(field(record, "credit"));
    const amount = parseAmount(field(record, "amount"));
    if (debit === null || credit === null || amount === null) {
      invalidAmount = true;
    }
    if (accounts.length > 0) {
      const lineAmount = Math.max(debit ?? 0, credit ?? 0, amount ?? 0);
      for (const account of accounts) {
        lines.push({ account, amount: lineAmount });
      }
    }
    for (const name of ["transactiondate", "paymentdate"]) {
      const raw = field(record, name);
      if (raw === undefined || raw === null || raw === "") {
        continue;
      }
      if (typeof raw !== "string" || !isIsoDate(raw)) {
        invalidDate = true;
      } else {
        dates.push(raw);
      }
    }
    const rawCurrency = field(record, "currency") ?? field(record, "currencycode");
    if (typeof rawCurrency === "string" && rawCurrency.trim() !== "") {
      const code = rawCurrency.trim().toUpperCase();
      currency = code;
      if (code !== "SEK") {
        invalidCurrency = true;
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        visit(value);
      }
    }
  };

  visit(body);
  return { lines, invalidAccount, invalidAmount, dates, invalidDate, currency, invalidCurrency };
}

export type ApprovalNeed =
  | { kind: "ask_account"; accounts: number[] }
  | { kind: "amount_threshold"; category: string; amount: number };

export type WriteAssessment =
  | { ok: false; reason: string; needs: ApprovalNeed[] }
  | { ok: true; needs: ApprovalNeed[]; maxLineAmount: number; blockedAccounts: number[] };

export function assessWrite(input: {
  writeClass: WriteClass;
  category: string | null;
  transactionDate: string | null;
  body: unknown;
  blocked: ReadonlySet<number>;
  thresholdSek: number;
  today: string;
  financialYearStart: string | null;
  financialYearEnd: string | null;
  requireBodyDate: boolean;
}): WriteAssessment {
  const category = input.category ?? "";
  if (!CATEGORIES_BY_WRITE[input.writeClass].includes(category)) {
    return { ok: false, reason: "invalid_category", needs: [] };
  }
  const extracted = extractWrite(input.body);
  if (extracted.invalidAccount) {
    return { ok: false, reason: "invalid_account", needs: [] };
  }
  if (extracted.invalidAmount) {
    return { ok: false, reason: "invalid_amount", needs: [] };
  }
  if (extracted.invalidDate) {
    return { ok: false, reason: "invalid_date", needs: [] };
  }
  if (extracted.invalidCurrency) {
    return { ok: false, reason: "currency", needs: [] };
  }

  const needsDate = DATED_WRITES.has(input.writeClass);
  if (needsDate) {
    if (!input.transactionDate || !isIsoDate(input.transactionDate)) {
      return { ok: false, reason: "invalid_date", needs: [] };
    }
    const bounds = periodBounds(input.today, input.financialYearStart, input.financialYearEnd);
    if (!bounds) {
      return { ok: false, reason: "financial_year_unconfigured", needs: [] };
    }
    if (!dateAllowed(input.transactionDate, bounds)) {
      return { ok: false, reason: "period", needs: [] };
    }
    if (extracted.dates.some((date) => date !== input.transactionDate)) {
      return { ok: false, reason: "date_mismatch", needs: [] };
    }
    if (input.requireBodyDate && !extracted.dates.includes(input.transactionDate)) {
      return { ok: false, reason: "date_mismatch", needs: [] };
    }
  }

  if (input.blocked.size === 0) {
    return { ok: false, reason: "policy_unavailable", needs: [] };
  }

  const blockedAccounts = [...new Set(extracted.lines.map((line) => line.account).filter((account) => input.blocked.has(account)))].sort((a, b) => a - b);
  const maxLineAmount = extracted.lines.reduce((max, line) => Math.max(max, line.amount), 0);
  const needs: ApprovalNeed[] = [];
  if (blockedAccounts.length > 0) {
    needs.push({ kind: "ask_account", accounts: blockedAccounts });
  }
  if (THRESHOLD_CATEGORIES.includes(category as typeof THRESHOLD_CATEGORIES[number]) && maxLineAmount > input.thresholdSek) {
    needs.push({ kind: "amount_threshold", category, amount: maxLineAmount });
  }
  return { ok: true, needs, maxLineAmount, blockedAccounts };
}

function covers(approval: ApprovalRecord, need: ApprovalNeed, request: {
  agentId: string;
  category: string;
  transactionDate: string | null;
  payloadHash: string;
  now: Date;
}): boolean {
  if (approval.agentId !== request.agentId || approval.kind !== need.kind || approval.usedAt) {
    return false;
  }
  if (Date.parse(approval.expiresAt) <= request.now.getTime()) {
    return false;
  }
  if (approval.category && approval.category !== request.category) {
    return false;
  }
  if (approval.transactionDate && approval.transactionDate !== request.transactionDate) {
    return false;
  }
  if (approval.payloadHash && approval.payloadHash !== request.payloadHash) {
    return false;
  }
  if (need.kind === "ask_account") {
    return need.accounts.every((account) => approval.accounts.includes(account));
  }
  return approval.category === need.category && approval.maxAmountSek !== null && approval.maxAmountSek >= need.amount;
}

export function matchApprovals(needs: ApprovalNeed[], provided: ApprovalRecord[], request: {
  agentId: string;
  category: string;
  transactionDate: string | null;
  payloadHash: string;
  now: Date;
}): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (needs.length === 0 && provided.length === 0) {
    return { ok: true, ids: [] };
  }
  if (provided.length === 0) {
    return { ok: false, reason: needs[0].kind === "ask_account" ? "ask_account" : "amount_threshold" };
  }
  if (provided.length !== needs.length) {
    return { ok: false, reason: needs.length === 0 ? "approval_not_required" : "approval_required" };
  }
  const used = new Set<string>();
  const ids: string[] = [];
  for (const need of needs) {
    const match = provided.find((approval) => !used.has(approval.id) && covers(approval, need, request));
    if (!match) {
      const sameKind = provided.filter((approval) => approval.kind === need.kind);
      if (sameKind.some((approval) => approval.usedAt)) {
        return { ok: false, reason: "approval_used" };
      }
      if (sameKind.some((approval) => Date.parse(approval.expiresAt) <= request.now.getTime())) {
        return { ok: false, reason: "approval_expired" };
      }
      return { ok: false, reason: need.kind === "ask_account" ? "ask_account" : "amount_threshold" };
    }
    used.add(match.id);
    ids.push(match.id);
  }
  return { ok: true, ids };
}
