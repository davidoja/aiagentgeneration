import { assertEquals, assertOk } from "./assert.ts";
import { blockedAccountNumbers } from "./blocked_accounts.ts";
import { handleFinanceGateway, functionSubpath, type GatewayDeps } from "./handler.ts";
import { sha256Hex } from "./hash.ts";
import type { AgentRecord, ApprovalRecord, AuditEvent, FinanceStore, FortnoxClient, OauthRecord, PolicyRecord } from "./types.ts";

const NOW = new Date("2026-09-24T10:00:00.000Z");
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_TOKEN = "fg_test_agent_token_placeholder";
const ADMIN_TOKEN = "admin-test-token-placeholder";
const REFRESH_SENTINEL = "refresh-sentinel-do-not-leak";
const REFRESH_ROTATED = "refresh-rotated-placeholder";
const ACCESS_SENTINEL = "access-new-placeholder";

type Memory = FinanceStore & {
  policy: PolicyRecord;
  agent: AgentRecord;
  approvals: Map<string, ApprovalRecord>;
  oauth: OauthRecord | null;
  audit: AuditEvent[];
  failPolicy: boolean;
  failBlocked: boolean;
  failOauthSave: boolean;
};

function memory(tokenHash: string): Memory {
  const agent: AgentRecord = {
    id: AGENT_ID,
    name: "Ekonomi-Erik",
    tokenHash,
    revokedAt: null,
    killSwitch: false,
  };
  const state: Memory = {
    policy: {
      globalKillSwitch: false,
      killSwitchReason: null,
      amountThresholdSek: 10000,
      financialYearStart: "2026-01-01",
      financialYearEnd: "2026-12-31",
    },
    agent,
    approvals: new Map(),
    oauth: { accessToken: null, refreshToken: REFRESH_SENTINEL, accessExpiresAt: null },
    audit: [],
    failPolicy: false,
    failBlocked: false,
    failOauthSave: false,
    getAgentByTokenHash(hash) {
      return Promise.resolve(hash === state.agent.tokenHash ? state.agent : null);
    },
    getPolicy() {
      if (state.failPolicy) {
        return Promise.reject(new Error("policy down"));
      }
      return Promise.resolve(state.policy);
    },
    listBlockedAccounts() {
      if (state.failBlocked) {
        return Promise.reject(new Error("accounts down"));
      }
      return Promise.resolve(blockedAccountNumbers());
    },
    getApprovals(ids) {
      return Promise.resolve(ids.map((id) => state.approvals.get(id)).filter((row): row is ApprovalRecord => Boolean(row)));
    },
    consumeApprovals(ids, agentId, requestId, now) {
      if (ids.length === 0) {
        return Promise.resolve(true);
      }
      const rows = ids.map((id) => state.approvals.get(id));
      if (new Set(ids).size !== ids.length || rows.some((row) => !row || row.agentId !== agentId || row.usedAt || Date.parse(row.expiresAt) <= now.getTime())) {
        return Promise.resolve(false);
      }
      for (const row of rows) {
        if (row) {
          row.usedAt = now.toISOString();
          state.approvals.set(row.id, row);
        }
      }
      void requestId;
      return Promise.resolve(true);
    },
    insertAudit(event) {
      state.audit.push(event);
      return Promise.resolve();
    },
    getOauth() {
      return Promise.resolve(state.oauth);
    },
    saveOauth(next) {
      if (state.failOauthSave) {
        return Promise.reject(new Error("persist failed"));
      }
      state.oauth = { ...next };
      return Promise.resolve();
    },
    createAgent(name, hash) {
      state.agent = { ...state.agent, id: "22222222-2222-4222-8222-222222222222", name, tokenHash: hash, revokedAt: null, killSwitch: false };
      return Promise.resolve({ id: state.agent.id });
    },
    revokeAgent(id, now) {
      if (state.agent.id !== id || state.agent.revokedAt) {
        return Promise.resolve(false);
      }
      state.agent = { ...state.agent, revokedAt: now.toISOString() };
      return Promise.resolve(true);
    },
    setAgentKillSwitch(id, engaged, reason) {
      if (state.agent.id !== id) {
        return Promise.resolve(false);
      }
      state.agent = { ...state.agent, killSwitch: engaged };
      void reason;
      return Promise.resolve(true);
    },
    setGlobalKillSwitch(engaged, reason) {
      state.policy = { ...state.policy, globalKillSwitch: engaged, killSwitchReason: reason };
      return Promise.resolve();
    },
    updatePolicy(patch) {
      state.policy = { ...state.policy, ...patch };
      return Promise.resolve();
    },
    createApproval(input) {
      const id = `33333333-3333-4333-8333-${String(state.approvals.size + 1).padStart(12, "0")}`;
      state.approvals.set(id, {
        id,
        agentId: input.agentId,
        kind: input.kind,
        category: input.category,
        accounts: input.accounts,
        maxAmountSek: input.maxAmountSek,
        transactionDate: input.transactionDate,
        payloadHash: input.payloadHash,
        expiresAt: input.expiresAt,
        usedAt: null,
      });
      return Promise.resolve({ id });
    },
    listAudit(limit) {
      return Promise.resolve(state.audit.slice(-limit).reverse());
    },
  };
  return state;
}

function mockFortnox() {
  const calls: Array<{ kind: "refresh" | "request"; refreshToken?: string; accessToken?: string; method?: string; path?: string }> = [];
  const client: FortnoxClient = {
    refresh(refreshToken) {
      calls.push({ kind: "refresh", refreshToken });
      return Promise.resolve({ accessToken: ACCESS_SENTINEL, refreshToken: REFRESH_ROTATED, expiresIn: 3600 });
    },
    request(input) {
      calls.push({ kind: "request", accessToken: input.accessToken, method: input.method, path: input.path });
      return Promise.resolve({
        status: 201,
        body: {
          Voucher: { VoucherNumber: 1, Description: "ok" },
          refresh_token: REFRESH_ROTATED,
          access_token: ACCESS_SENTINEL,
          note: `saw ${REFRESH_SENTINEL} and ${REFRESH_ROTATED}`,
        },
      });
    },
  };
  return { client, calls };
}

function voucher(date: string, rows: Array<{ account: number; debit: number; credit: number }>) {
  return {
    Voucher: {
      Description: "Testbokning",
      TransactionDate: date,
      VoucherSeries: "A",
      VoucherRows: rows.map((row) => ({ Account: row.account, Debit: row.debit, Credit: row.credit })),
    },
  };
}

function routineBody(date = "2026-09-01") {
  return voucher(date, [
    { account: 1930, debit: 100, credit: 0 },
    { account: 3001, debit: 0, credit: 100 },
  ]);
}

async function setup() {
  const store = memory(await sha256Hex(AGENT_TOKEN));
  const fortnox = mockFortnox();
  const logs: Record<string, unknown>[] = [];
  const deps: GatewayDeps = {
    adminToken: ADMIN_TOKEN,
    store,
    fortnox: fortnox.client,
    now: () => NOW,
    log: (event) => logs.push(event),
  };
  return { store, fortnox, deps, logs };
}

function post(token: string, body: unknown, path = "https://project.example.test/functions/v1/finance-gateway"): Request {
  return new Request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  assertOk(!text.includes(REFRESH_SENTINEL), text);
  assertOk(!text.includes(REFRESH_ROTATED), text);
  assertOk(!text.includes(ACCESS_SENTINEL), text);
  assertOk(!text.includes(ADMIN_TOKEN), text);
}

Deno.test("parses the function subpath", () => {
  assertEquals(functionSubpath("https://project.example.test/functions/v1/finance-gateway"), "/");
  assertEquals(functionSubpath("https://project.example.test/functions/v1/finance-gateway/admin/agents"), "/admin/agents");
});

Deno.test("allows a routine voucher and records an audit hash", async () => {
  const { deps, fortnox, store } = await setup();
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "routine",
    transactionDate: "2026-09-01",
    body: routineBody(),
  }), deps);
  const payload = await response.json();
  assertEquals(response.status, 200);
  assertEquals(payload.ok, true);
  assertEquals(payload.decision, "allowed");
  assertEquals(payload.fortnoxCalled, true);
  assertEquals(fortnox.calls.map((call) => call.kind), ["refresh", "request"]);
  assertEquals(fortnox.calls[1].path, "/3/vouchers");
  assertEquals(fortnox.calls[1].method, "POST");
  assertEquals(store.oauth?.refreshToken, REFRESH_ROTATED);
  assertEquals(store.audit[0].decision, "allowed");
  assertEquals(store.audit[0].path, "/3/vouchers");
  assertEquals(store.audit[0].source, "agent");
  assertOk(/^[0-9a-f]{64}$/.test(store.audit[0].payloadHash));
  noSecrets(payload);
  noSecrets(store.audit);
});

Deno.test("rejects a write that is not on the allowlist", async () => {
  const { deps, fortnox } = await setup();
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/invoices",
    category: "routine",
    transactionDate: "2026-09-01",
    body: { Invoice: { InvoiceDate: "2026-09-01" } },
  }), deps);
  assertEquals(response.status, 403);
  assertEquals((await response.json()).reason, "not_allowlisted");
  assertEquals(fortnox.calls.length, 0);
});

Deno.test("rejects DELETE of a supplier invoice payment", async () => {
  const { deps, fortnox, store } = await setup();
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "DELETE",
    path: "/3/supplierinvoicepayments/15",
  }), deps);
  const payload = await response.json();
  assertEquals(response.status, 403);
  assertEquals(payload.reason, "delete_forbidden");
  assertEquals(payload.fortnoxCalled, false);
  assertEquals(fortnox.calls.length, 0);
  assertEquals(store.audit[0].decision, "denied");
});

Deno.test("rejects settings, modes of payment, and bank payment initiation", async () => {
  const cases = [
    { method: "GET", path: "/3/settings/company", reason: "settings_forbidden" },
    { method: "POST", path: "/3/modesofpayments", reason: "settings_forbidden" },
    { method: "PUT", path: "/3/predefinedaccounts", reason: "settings_forbidden" },
    { method: "PUT", path: "/3/supplierinvoices/9/approvalpayment", reason: "bank_payment_forbidden" },
    { method: "POST", path: "/3/bankpayments", reason: "bank_payment_forbidden" },
  ];
  for (const item of cases) {
    const { deps, fortnox } = await setup();
    const response = await handleFinanceGateway(post(AGENT_TOKEN, { method: item.method, path: item.path }), deps);
    assertEquals((await response.json()).reason, item.reason, item.path);
    assertEquals(fortnox.calls.length, 0, item.path);
  }
});

Deno.test("blocks an ASK account unless a one-time approval is consumed", async () => {
  const { deps, fortnox, store } = await setup();
  const body = voucher("2026-09-01", [
    { account: 2010, debit: 100, credit: 0 },
    { account: 1930, debit: 0, credit: 100 },
  ]);
  const envelope = {
    method: "POST",
    path: "/3/vouchers",
    category: "routine",
    transactionDate: "2026-09-01",
    body,
  };
  const blocked = await handleFinanceGateway(post(AGENT_TOKEN, envelope), deps);
  assertEquals((await blocked.json()).reason, "ask_account");
  assertEquals(fortnox.calls.length, 0);

  const approvalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  store.approvals.set(approvalId, {
    id: approvalId,
    agentId: AGENT_ID,
    kind: "ask_account",
    category: "routine",
    accounts: [2010],
    maxAmountSek: null,
    transactionDate: "2026-09-01",
    payloadHash: null,
    expiresAt: "2026-10-01T00:00:00.000Z",
    usedAt: null,
  });
  const allowed = await handleFinanceGateway(post(AGENT_TOKEN, { ...envelope, approvalId }), deps);
  assertEquals((await allowed.json()).decision, "allowed");
  assertEquals(store.approvals.get(approvalId)?.usedAt, NOW.toISOString());
  const again = await handleFinanceGateway(post(AGENT_TOKEN, { ...envelope, approvalId }), deps);
  assertEquals((await again.json()).reason, "approval_used");
  assertEquals(fortnox.calls.filter((call) => call.kind === "request").length, 1);
});

Deno.test("rejects an expired approval", async () => {
  const { deps, fortnox, store } = await setup();
  const approvalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  store.approvals.set(approvalId, {
    id: approvalId,
    agentId: AGENT_ID,
    kind: "ask_account",
    category: null,
    accounts: [2650],
    maxAmountSek: null,
    transactionDate: null,
    payloadHash: null,
    expiresAt: "2026-09-01T00:00:00.000Z",
    usedAt: null,
  });
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "routine",
    transactionDate: "2026-09-01",
    approvalId,
    body: voucher("2026-09-01", [
      { account: 2650, debit: 50, credit: 0 },
      { account: 1930, debit: 0, credit: 50 },
    ]),
  }), deps);
  assertEquals((await response.json()).reason, "approval_expired");
  assertEquals(fortnox.calls.length, 0);
  assertEquals(store.approvals.get(approvalId)?.usedAt, null);
});

Deno.test("enforces the period rule", async () => {
  const dates = [
    { date: "2026-07-31", reason: "period" },
    { date: "2026-09-25", reason: "period" },
    { date: "2025-12-15", reason: "period" },
    { date: "2026-08-01", reason: null },
    { date: "2026-09-24", reason: null },
  ];
  for (const item of dates) {
    const { deps, fortnox } = await setup();
    const response = await handleFinanceGateway(post(AGENT_TOKEN, {
      method: "POST",
      path: "/3/vouchers",
      category: "routine",
      transactionDate: item.date,
      body: routineBody(item.date),
    }), deps);
    const payload = await response.json();
    if (item.reason) {
      assertEquals(payload.reason, item.reason, item.date);
      assertEquals(fortnox.calls.length, 0, item.date);
    } else {
      assertEquals(payload.decision, "allowed", item.date);
    }
  }
});

Deno.test("requires approval when a threshold category line is above 10000 SEK", async () => {
  const { deps, fortnox, store } = await setup();
  const body = voucher("2026-09-02", [
    { account: 1930, debit: 10000, credit: 0 },
    { account: 2440, debit: 0, credit: 10000 },
  ]);
  const atLimit = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "reclassification",
    transactionDate: "2026-09-02",
    body,
  }), deps);
  assertEquals((await atLimit.json()).decision, "allowed");

  const over = voucher("2026-09-02", [
    { account: 1930, debit: 10000.01, credit: 0 },
    { account: 2440, debit: 0, credit: 10000.01 },
  ]);
  const denied = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "reclassification",
    transactionDate: "2026-09-02",
    body: over,
  }), deps);
  assertEquals((await denied.json()).reason, "amount_threshold");

  const approvalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  store.approvals.set(approvalId, {
    id: approvalId,
    agentId: AGENT_ID,
    kind: "amount_threshold",
    category: "reclassification",
    accounts: [],
    maxAmountSek: 20000,
    transactionDate: "2026-09-02",
    payloadHash: null,
    expiresAt: "2026-10-01T00:00:00.000Z",
    usedAt: null,
  });
  const allowed = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "reclassification",
    transactionDate: "2026-09-02",
    approvalId,
    body: over,
  }), deps);
  assertEquals((await allowed.json()).decision, "allowed");
  assertEquals(fortnox.calls.filter((call) => call.kind === "request").length, 2);
});

Deno.test("kill switch fails closed for the global switch, the agent switch, and a policy outage", async () => {
  const global = await setup();
  global.store.policy.globalKillSwitch = true;
  const stopped = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/companyinformation" }), global.deps);
  assertEquals((await stopped.json()).reason, "kill_switch");
  assertEquals(global.fortnox.calls.length, 0);

  const personal = await setup();
  personal.store.agent.killSwitch = true;
  const stoppedAgent = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/vouchers" }), personal.deps);
  assertEquals((await stoppedAgent.json()).reason, "kill_switch");
  assertEquals(personal.fortnox.calls.length, 0);

  const outage = await setup();
  outage.store.failPolicy = true;
  const down = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/accounts" }), outage.deps);
  assertEquals(down.status, 503);
  assertEquals((await down.json()).reason, "policy_unavailable");
  assertEquals(outage.fortnox.calls.length, 0);
});

Deno.test("rejects a bad agent token and a revoked agent", async () => {
  const { deps, fortnox, store } = await setup();
  const bad = await handleFinanceGateway(post("fg_not_a_real_token", { method: "GET", path: "/3/customers" }), deps);
  assertEquals(bad.status, 401);
  assertEquals((await bad.json()).reason, "unauthorized");
  assertEquals(fortnox.calls.length, 0);

  store.agent.revokedAt = NOW.toISOString();
  const revoked = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/customers" }), deps);
  assertEquals(revoked.status, 401);
  assertEquals(fortnox.calls.length, 0);
});

Deno.test("dry-run validates and audits without calling Fortnox or consuming an approval", async () => {
  const { deps, fortnox, store } = await setup();
  const approvalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  store.approvals.set(approvalId, {
    id: approvalId,
    agentId: AGENT_ID,
    kind: "ask_account",
    category: null,
    accounts: [1630],
    maxAmountSek: null,
    transactionDate: null,
    payloadHash: null,
    expiresAt: "2026-10-01T00:00:00.000Z",
    usedAt: null,
  });
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/vouchers",
    category: "routine",
    transactionDate: "2026-09-03",
    dryRun: true,
    approvalId,
    body: voucher("2026-09-03", [
      { account: 1630, debit: 20, credit: 0 },
      { account: 1930, debit: 0, credit: 20 },
    ]),
  }), deps);
  const payload = await response.json();
  assertEquals(payload.decision, "dry_run");
  assertEquals(payload.fortnoxCalled, false);
  assertEquals(fortnox.calls.length, 0);
  assertEquals(store.approvals.get(approvalId)?.usedAt, null);
  assertEquals(store.audit[0].dryRun, true);
  assertEquals(store.audit[0].decision, "dry_run");
});

Deno.test("persists a rotated refresh token and does not echo it", async () => {
  const { deps, fortnox, store, logs } = await setup();
  const first = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/financialyears" }), deps);
  noSecrets(await first.json());
  assertEquals(store.oauth?.refreshToken, REFRESH_ROTATED);
  assertEquals(store.oauth?.accessToken, ACCESS_SENTINEL);
  assertEquals(fortnox.calls[0].refreshToken, REFRESH_SENTINEL);

  const second = await handleFinanceGateway(post(AGENT_TOKEN, { method: "GET", path: "/3/suppliers" }), deps);
  assertEquals((await second.json()).decision, "allowed");
  assertEquals(fortnox.calls.filter((call) => call.kind === "refresh").length, 1);
  assertEquals(fortnox.calls.at(-1)?.accessToken, ACCESS_SENTINEL);
  noSecrets(store.audit);
  noSecrets(logs);
});

Deno.test("does not call the Fortnox API when refresh-token persistence fails", async () => {
  const { deps, fortnox, store } = await setup();
  store.failOauthSave = true;
  const response = await handleFinanceGateway(post(AGENT_TOKEN, {
    method: "POST",
    path: "/3/invoicepayments",
    category: "payment",
    transactionDate: "2026-09-10",
    body: { InvoicePayment: { InvoiceNumber: "1", Amount: 100, PaymentDate: "2026-09-10", ModeOfPaymentAccount: 1930 } },
  }), deps);
  const payload = await response.json();
  assertEquals(response.status, 503);
  assertEquals(payload.reason, "oauth_persist_failed");
  assertEquals(payload.fortnoxCalled, false);
  assertEquals(fortnox.calls.map((call) => call.kind), ["refresh"]);
  assertEquals(store.oauth?.refreshToken, REFRESH_SENTINEL);
  noSecrets(payload);
});

Deno.test("allows payment bookkeep, file connection, archive upload, and a monitoring read", async () => {
  const { deps, fortnox } = await setup();
  const calls = [
    {
      method: "POST",
      path: "/3/invoicepayments",
      category: "payment",
      transactionDate: "2026-09-10",
      body: { InvoicePayment: { InvoiceNumber: "1", Amount: 10, PaymentDate: "2026-09-10", ModeOfPaymentAccount: 1930 } },
    },
    {
      method: "PUT",
      path: "/3/supplierinvoicepayments/15/bookkeep",
      category: "payment",
      transactionDate: "2026-09-10",
      body: {},
    },
    {
      method: "POST",
      path: "/3/voucherfileconnections",
      category: "file",
      body: { VoucherFileConnection: { FileId: "file-placeholder", VoucherSeries: "A", VoucherNumber: 1 } },
    },
    {
      method: "POST",
      path: "/3/archive",
      category: "archive",
      body: { fileName: "receipt.pdf", contentType: "application/pdf", contentBase64: btoa("placeholder-pdf") },
    },
    { method: "GET", path: "/3/companyinformation" },
  ];
  for (const body of calls) {
    const response = await handleFinanceGateway(post(AGENT_TOKEN, body), deps);
    assertEquals((await response.json()).decision, "allowed", body.path);
  }
  assertEquals(
    fortnox.calls.filter((call) => call.kind === "request").map((call) => `${call.method} ${call.path}`),
    calls.map((call) => `${call.method} ${call.path}`),
  );
});

Deno.test("the agent token cannot change the kill switch or create an approval", async () => {
  const { deps, fortnox, store } = await setup();
  store.policy.globalKillSwitch = true;
  const response = await handleFinanceGateway(post(AGENT_TOKEN, { engaged: false }, "https://project.example.test/functions/v1/finance-gateway/admin/kill-switch"), deps);
  assertEquals(response.status, 401);
  assertEquals(store.policy.globalKillSwitch, true);
  assertEquals(store.approvals.size, 0);
  assertEquals(fortnox.calls.length, 0);
});

Deno.test("admin issues an agent token once and can seed a refresh token without returning it", async () => {
  const { deps, store } = await setup();
  const created = await handleFinanceGateway(post(ADMIN_TOKEN, { name: "Ekonomi-Erik" }, "https://project.example.test/functions/v1/finance-gateway/admin/agents"), deps);
  const payload = await created.json();
  assertEquals(created.status, 201);
  assertOk(typeof payload.token === "string" && payload.token.startsWith("fg_"));
  const issued = payload.token as string;
  assertOk(!JSON.stringify(store.audit).includes(issued));

  const seeded = await handleFinanceGateway(post(ADMIN_TOKEN, { refreshToken: "seed-refresh-placeholder" }, "https://project.example.test/functions/v1/finance-gateway/admin/oauth/refresh-token"), deps);
  const seedBody = await seeded.json();
  assertEquals(seedBody.ok, true);
  assertEquals(store.oauth?.refreshToken, "seed-refresh-placeholder");
  assertOk(!JSON.stringify(seedBody).includes("seed-refresh-placeholder"));
  assertOk(!JSON.stringify(store.audit).includes("seed-refresh-placeholder"));

  store.oauth = { accessToken: ACCESS_SENTINEL, refreshToken: REFRESH_ROTATED, accessExpiresAt: "2026-09-24T12:00:00.000Z" };
  const used = await handleFinanceGateway(post(issued, { method: "GET", path: "/3/inbox" }), deps);
  assertEquals((await used.json()).decision, "allowed");
});
