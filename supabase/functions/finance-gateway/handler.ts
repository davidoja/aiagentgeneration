import { matchRoute, normalizeQuery } from "./allowlist.ts";
import { decodeArchive, DEFAULT_FORTNOX_REDIRECT_URI, extractOAuthCallback, isFortnoxTenantId, normalizeRedirectUri, scopesFrom } from "./fortnox.ts";
import { payloadHash, sha256Hex, timingSafeEqual } from "./hash.ts";
import { assessWrite, matchApprovals, stockholmDate } from "./policy.ts";
import { redact } from "./redact.ts";
import type { AgentRecord, ApprovalRecord, AuditEvent, FinanceStore, FortnoxClient, OauthRecord } from "./types.ts";

export type GatewayDeps = {
  adminToken: string;
  redirectUri: string;
  expectedOauthState: string;
  tenantId: string;
  store: FinanceStore;
  fortnox: FortnoxClient;
  now: () => Date;
  log?: (event: Record<string, unknown>) => void;
};

const ACCESS_SKEW_MS = 60_000;

const ENVELOPE_KEYS = new Set([
  "method",
  "path",
  "query",
  "body",
  "category",
  "dryRun",
  "transactionDate",
  "approvalId",
  "approvalIds",
]);

type AgentEnvelope = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  category: string | null;
  dryRun: boolean;
  transactionDate: string | null;
  approvalIds: string[];
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function denied(reason: string, status = 403, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, decision: "denied", reason, fortnoxCalled: false, ...extra }, status);
}

export function functionSubpath(url: string): string {
  const parsed = new URL(url);
  let path = parsed.pathname;
  const marker = "/finance-gateway";
  const index = path.lastIndexOf(marker);
  if (index >= 0) {
    path = path.slice(index + marker.length);
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path === "" ? "/" : path;
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

async function audit(deps: GatewayDeps, event: AuditEvent): Promise<boolean> {
  try {
    await deps.store.insertAudit(event);
    return true;
  } catch {
    deps.log?.({ decision: "error", reason: "audit_failed", path: event.path, requestId: event.requestId });
    return false;
  }
}

function baseAudit(partial: Omit<AuditEvent, "payloadHash"> & { payloadHash?: string }, hash: string): AuditEvent {
  return { ...partial, payloadHash: hash };
}

function accessStillValid(current: OauthRecord | null, now: Date, kind: OauthRecord["tokenKind"]): boolean {
  if (!current || current.tokenKind !== kind || !current.accessToken) {
    return false;
  }
  const expiry = current.accessExpiresAt ? Date.parse(current.accessExpiresAt) : 0;
  return expiry - now.getTime() > ACCESS_SKEW_MS;
}

async function loadOauth(deps: GatewayDeps): Promise<OauthRecord | null | { error: string }> {
  try {
    return await deps.store.getOauth();
  } catch {
    return { error: "oauth_unavailable" };
  }
}

async function ensureClientCredentials(
  deps: GatewayDeps,
  now: Date,
  tenantId: string,
): Promise<{ accessToken: string; secrets: string[] } | { error: string }> {
  if (!isFortnoxTenantId(tenantId)) {
    return { error: "server_misconfigured" };
  }
  const current = await loadOauth(deps);
  if (current && "error" in current) {
    return current;
  }
  if (accessStillValid(current, now, "client_credentials") && current?.accessToken) {
    return { accessToken: current.accessToken, secrets: [current.accessToken] };
  }
  let minted;
  try {
    minted = await deps.fortnox.clientCredentials({ tenantId });
  } catch (error) {
    const unconfigured = error instanceof Error && error.message === "oauth_unconfigured";
    return { error: unconfigured ? "server_misconfigured" : "oauth_client_credentials_failed" };
  }
  const next: OauthRecord = {
    accessToken: minted.accessToken,
    refreshToken: null,
    accessExpiresAt: new Date(now.getTime() + minted.expiresIn * 1000).toISOString(),
    tokenKind: "client_credentials",
  };
  try {
    await deps.store.saveOauth(next);
  } catch {
    return { error: "oauth_persist_failed" };
  }
  return { accessToken: minted.accessToken, secrets: [minted.accessToken] };
}

async function ensureRefreshToken(deps: GatewayDeps, now: Date): Promise<{ accessToken: string; secrets: string[] } | { error: string }> {
  const current = await loadOauth(deps);
  if (current && "error" in current) {
    return current;
  }
  if (!current?.refreshToken || current.tokenKind === "client_credentials") {
    return { error: "oauth_unavailable" };
  }
  if (accessStillValid(current, now, "refresh")) {
    return { accessToken: current.accessToken as string, secrets: [current.accessToken as string, current.refreshToken] };
  }
  let refreshed;
  try {
    refreshed = await deps.fortnox.refresh(current.refreshToken);
  } catch {
    return { error: "oauth_refresh_failed" };
  }
  if (!refreshed.refreshToken || !refreshed.accessToken || refreshed.expiresIn <= 0) {
    return { error: "oauth_refresh_failed" };
  }
  const next: OauthRecord = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    accessExpiresAt: new Date(now.getTime() + refreshed.expiresIn * 1000).toISOString(),
    tokenKind: "refresh",
  };
  try {
    await deps.store.saveOauth(next);
  } catch {
    return { error: "oauth_persist_failed" };
  }
  return {
    accessToken: refreshed.accessToken,
    secrets: [refreshed.accessToken, refreshed.refreshToken, current.refreshToken],
  };
}

async function ensureAccess(deps: GatewayDeps, now: Date): Promise<{ accessToken: string; secrets: string[] } | { error: string }> {
  const tenantId = deps.tenantId.trim();
  if (tenantId) {
    return ensureClientCredentials(deps, now, tenantId);
  }
  return ensureRefreshToken(deps, now);
}

function parseEnvelope(payload: unknown): AgentEnvelope | { error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_envelope" };
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return { error: "invalid_envelope" };
    }
  }
  if (typeof record.method !== "string" || typeof record.path !== "string") {
    return { error: "invalid_envelope" };
  }
  const query = normalizeQuery(record.query);
  if (!query) {
    return { error: "invalid_query" };
  }
  if (record.dryRun !== undefined && typeof record.dryRun !== "boolean") {
    return { error: "invalid_envelope" };
  }
  if (record.category !== undefined && typeof record.category !== "string") {
    return { error: "invalid_category" };
  }
  if (record.transactionDate !== undefined && record.transactionDate !== null && typeof record.transactionDate !== "string") {
    return { error: "invalid_date" };
  }
  const ids = new Set<string>();
  if (typeof record.approvalId === "string") {
    ids.add(record.approvalId);
  } else if (record.approvalId !== undefined && record.approvalId !== null) {
    return { error: "invalid_approval" };
  }
  if (record.approvalIds !== undefined) {
    if (!Array.isArray(record.approvalIds) || record.approvalIds.length > 2) {
      return { error: "invalid_approval" };
    }
    for (const id of record.approvalIds) {
      if (typeof id !== "string") {
        return { error: "invalid_approval" };
      }
      ids.add(id);
    }
  }
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { error: "invalid_approval" };
    }
  }
  return {
    method: record.method,
    path: record.path,
    query,
    body: record.body ?? null,
    category: typeof record.category === "string" ? record.category : null,
    dryRun: record.dryRun === true,
    transactionDate: typeof record.transactionDate === "string" ? record.transactionDate : null,
    approvalIds: [...ids],
  };
}

async function loadApprovals(store: FinanceStore, ids: string[]): Promise<ApprovalRecord[] | null> {
  try {
    const rows = await store.getApprovals(ids);
    return rows.length === ids.length ? rows : rows;
  } catch {
    return null;
  }
}

export async function handleFinanceGateway(req: Request, deps: GatewayDeps): Promise<Response> {
  const requestId = crypto.randomUUID();
  const subpath = functionSubpath(req.url);
  const now = deps.now();

  if (req.method !== "POST" && !(req.method === "GET" && subpath === "/admin/audit")) {
    return json({ ok: false, decision: "denied", reason: "method_not_allowed", fortnoxCalled: false }, 405);
  }

  let raw = "";
  if (req.method !== "GET") {
    raw = await req.text();
    if (raw.length > 12_000_000) {
      return denied("payload_too_large", 413);
    }
  }

  const token = bearer(req);
  if (!token) {
    return denied("unauthorized", 401);
  }

  if (subpath.startsWith("/admin")) {
    return handleAdmin(req, deps, subpath, raw, token, requestId, now);
  }
  if (subpath !== "/") {
    return denied("not_allowlisted");
  }
  return handleAgent(deps, raw, token, requestId, now);
}

async function handleAdmin(
  req: Request,
  deps: GatewayDeps,
  subpath: string,
  raw: string,
  token: string,
  requestId: string,
  now: Date,
): Promise<Response> {
  if (!deps.adminToken) {
    return json({ ok: false, decision: "error", reason: "server_misconfigured", fortnoxCalled: false }, 500);
  }
  if (!timingSafeEqual(token, deps.adminToken)) {
    const hashed = await payloadHash({ admin: true });
    await audit(deps, baseAudit({
      requestId,
      agentId: null,
      source: "admin",
      method: req.method,
      path: subpath,
      category: null,
      dryRun: false,
      decision: "denied",
      result: "unauthorized",
      reason: "unauthorized",
      httpStatus: 401,
      fortnoxStatus: null,
      approvalIds: [],
    }, hashed));
    return denied("unauthorized", 401);
  }

  let payload: unknown = null;
  if (req.method !== "GET") {
    try {
      payload = raw === "" ? {} : JSON.parse(raw);
    } catch {
      return denied("invalid_json", 400);
    }
  }

  const sensitive = subpath === "/admin/oauth/refresh-token" || subpath === "/admin/oauth/exchange-code";
  const hash = sensitive ? await sha256Hex(subpath) : await payloadHash(payload);

  const finish = async (status: number, body: Record<string, unknown>, decision: string, reason: string | null) => {
    await audit(deps, baseAudit({
      requestId,
      agentId: null,
      source: "admin",
      method: req.method,
      path: subpath,
      category: null,
      dryRun: false,
      decision,
      result: decision,
      reason,
      httpStatus: status,
      fortnoxStatus: null,
      approvalIds: [],
    }, hash));
    deps.log?.({ source: "admin", path: subpath, decision, reason, requestId });
    return json(body, status);
  };

  try {
    if (req.method === "GET" && subpath === "/admin/audit") {
      const limitRaw = new URL(req.url).searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_query", fortnoxCalled: false }, "denied", "invalid_query");
      }
      const rows = await deps.store.listAudit(limit);
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: false, audit: rows }, "allowed", null);
    }

    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    if (!record) {
      return finish(400, { ok: false, decision: "denied", reason: "invalid_json", fortnoxCalled: false }, "denied", "invalid_json");
    }

    if (req.method === "POST" && subpath === "/admin/agents") {
      if (typeof record.name !== "string" || !/^[A-Za-z0-9 ._-]{2,80}$/.test(record.name)) {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_agent", fortnoxCalled: false }, "denied", "invalid_agent");
      }
      const agentToken = `fg_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
      const created = await deps.store.createAgent(record.name, await sha256Hex(agentToken));
      return finish(201, { ok: true, decision: "allowed", fortnoxCalled: false, agentId: created.id, token: agentToken }, "allowed", null);
    }

    const agentMatch = /^\/admin\/agents\/([0-9a-f-]{36})\/(revoke|kill-switch)$/i.exec(subpath);
    if (req.method === "POST" && agentMatch) {
      const agentId = agentMatch[1];
      if (agentMatch[2] === "revoke") {
        const ok = await deps.store.revokeAgent(agentId, now);
        return finish(ok ? 200 : 404, { ok, decision: ok ? "allowed" : "denied", reason: ok ? null : "not_found", fortnoxCalled: false }, ok ? "allowed" : "denied", ok ? null : "not_found");
      }
      if (typeof record.engaged !== "boolean") {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_envelope", fortnoxCalled: false }, "denied", "invalid_envelope");
      }
      const reason = typeof record.reason === "string" ? record.reason.slice(0, 200) : null;
      const ok = await deps.store.setAgentKillSwitch(agentId, record.engaged, reason);
      return finish(ok ? 200 : 404, { ok, decision: ok ? "allowed" : "denied", reason: ok ? null : "not_found", fortnoxCalled: false }, ok ? "allowed" : "denied", ok ? null : "not_found");
    }

    if (req.method === "POST" && subpath === "/admin/kill-switch") {
      if (typeof record.engaged !== "boolean") {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_envelope", fortnoxCalled: false }, "denied", "invalid_envelope");
      }
      const reason = typeof record.reason === "string" ? record.reason.slice(0, 200) : null;
      await deps.store.setGlobalKillSwitch(record.engaged, reason);
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: false, engaged: record.engaged }, "allowed", null);
    }

    if (req.method === "POST" && subpath === "/admin/policy") {
      const patch: { amountThresholdSek?: number; financialYearStart?: string; financialYearEnd?: string } = {};
      if (record.amountThresholdSek !== undefined) {
        if (typeof record.amountThresholdSek !== "number" || record.amountThresholdSek < 0 || record.amountThresholdSek > 100_000_000) {
          return finish(400, { ok: false, decision: "denied", reason: "invalid_threshold", fortnoxCalled: false }, "denied", "invalid_threshold");
        }
        patch.amountThresholdSek = record.amountThresholdSek;
      }
      for (const key of ["financialYearStart", "financialYearEnd"] as const) {
        if (record[key] !== undefined) {
          if (typeof record[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record[key] as string)) {
            return finish(400, { ok: false, decision: "denied", reason: "invalid_date", fortnoxCalled: false }, "denied", "invalid_date");
          }
          patch[key] = record[key] as string;
        }
      }
      if (patch.financialYearStart && patch.financialYearEnd && patch.financialYearStart > patch.financialYearEnd) {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_date", fortnoxCalled: false }, "denied", "invalid_date");
      }
      await deps.store.updatePolicy(patch);
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: false }, "allowed", null);
    }

    if (req.method === "POST" && subpath === "/admin/approvals") {
      const created = await createApproval(deps, record, now);
      if ("error" in created) {
        return finish(400, { ok: false, decision: "denied", reason: created.error, fortnoxCalled: false }, "denied", created.error);
      }
      return finish(201, { ok: true, decision: "allowed", fortnoxCalled: false, approvalId: created.id }, "allowed", null);
    }

    if (req.method === "POST" && subpath === "/admin/oauth/exchange-code") {
      const redirectUri = normalizeRedirectUri(deps.redirectUri || DEFAULT_FORTNOX_REDIRECT_URI);
      if (!redirectUri) {
        return finish(500, { ok: false, decision: "error", reason: "server_misconfigured", fortnoxCalled: false }, "error", "server_misconfigured");
      }
      const extracted = extractOAuthCallback(record, redirectUri);
      if ("error" in extracted) {
        const status = extracted.error === "server_misconfigured" ? 500 : extracted.error === "oauth_state" ? 403 : 400;
        return finish(status, { ok: false, decision: status === 500 ? "error" : "denied", reason: extracted.error, fortnoxCalled: false }, status === 500 ? "error" : "denied", extracted.error);
      }
      if (deps.expectedOauthState) {
        if (!extracted.state || !timingSafeEqual(extracted.state, deps.expectedOauthState)) {
          return finish(403, { ok: false, decision: "denied", reason: "oauth_state", fortnoxCalled: false }, "denied", "oauth_state");
        }
      }
      let exchanged;
      try {
        exchanged = await deps.fortnox.exchangeCode({ code: extracted.code, redirectUri });
      } catch (error) {
        const unconfigured = error instanceof Error && error.message === "oauth_unconfigured";
        const reason = unconfigured ? "server_misconfigured" : "oauth_exchange_failed";
        return finish(unconfigured ? 500 : 502, { ok: false, decision: "error", reason, fortnoxCalled: !unconfigured }, "error", reason);
      }
      try {
        await deps.store.saveOauth({
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          accessExpiresAt: new Date(now.getTime() + exchanged.expiresIn * 1000).toISOString(),
          tokenKind: "refresh",
        });
      } catch {
        return finish(503, { ok: false, decision: "error", reason: "oauth_persist_failed", fortnoxCalled: true }, "error", "oauth_persist_failed");
      }
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: true, scopes: scopesFrom(exchanged.scope) }, "allowed", null);
    }

    if (req.method === "POST" && subpath === "/admin/oauth/refresh-token") {
      const refreshToken = record.refreshToken;
      if (typeof refreshToken !== "string" || refreshToken.length < 8 || refreshToken.length > 500) {
        return finish(400, { ok: false, decision: "denied", reason: "invalid_oauth", fortnoxCalled: false }, "denied", "invalid_oauth");
      }
      await deps.store.saveOauth({ accessToken: null, refreshToken, accessExpiresAt: null, tokenKind: "refresh" });
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: false }, "allowed", null);
    }

    if (req.method === "POST" && subpath === "/admin/payload-hash") {
      return finish(200, { ok: true, decision: "allowed", fortnoxCalled: false, payloadHash: await payloadHash(record.body ?? null) }, "allowed", null);
    }

    return finish(404, { ok: false, decision: "denied", reason: "not_allowlisted", fortnoxCalled: false }, "denied", "not_allowlisted");
  } catch {
    return json({ ok: false, decision: "error", reason: "internal", fortnoxCalled: false }, 500);
  }
}

async function createApproval(deps: GatewayDeps, record: Record<string, unknown>, now: Date): Promise<{ id: string } | { error: string }> {
  const agentId = record.agentId;
  const kind = record.kind;
  const expiresAt = record.expiresAt;
  if (typeof agentId !== "string" || (kind !== "ask_account" && kind !== "amount_threshold") || typeof expiresAt !== "string") {
    return { error: "invalid_approval" };
  }
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { error: "approval_expired" };
  }
  const accounts = Array.isArray(record.accounts) ? record.accounts : [];
  if (accounts.some((account) => typeof account !== "number" || !Number.isInteger(account) || account < 1000 || account > 9999)) {
    return { error: "invalid_account" };
  }
  if (kind === "ask_account" && accounts.length === 0) {
    return { error: "invalid_approval" };
  }
  const maxAmountSek = record.maxAmountSek === undefined || record.maxAmountSek === null ? null : record.maxAmountSek;
  if (maxAmountSek !== null && (typeof maxAmountSek !== "number" || maxAmountSek < 0)) {
    return { error: "invalid_threshold" };
  }
  if (kind === "amount_threshold" && (typeof record.category !== "string" || maxAmountSek === null)) {
    return { error: "invalid_approval" };
  }
  const transactionDate = typeof record.transactionDate === "string" ? record.transactionDate : null;
  const category = typeof record.category === "string" ? record.category : null;
  const hash = typeof record.payloadHash === "string" ? record.payloadHash : null;
  if (hash && !/^[0-9a-f]{64}$/.test(hash)) {
    return { error: "invalid_approval" };
  }
  const note = typeof record.note === "string" ? record.note.slice(0, 300) : null;
  return deps.store.createApproval({
    agentId,
    kind,
    category,
    accounts: accounts as number[],
    maxAmountSek: maxAmountSek as number | null,
    transactionDate,
    payloadHash: hash,
    note,
    expiresAt: new Date(expires).toISOString(),
  });
}

async function handleAgent(deps: GatewayDeps, raw: string, token: string, requestId: string, now: Date): Promise<Response> {
  const tokenHash = await sha256Hex(token);
  let agent: AgentRecord | null;
  try {
    agent = await deps.store.getAgentByTokenHash(tokenHash);
  } catch {
    return json({ ok: false, decision: "error", reason: "policy_unavailable", fortnoxCalled: false }, 503);
  }
  const hash = await payloadHash(raw);
  const reply = async (
    status: number,
    reason: string,
    decision: string,
    extra: Record<string, unknown> = {},
    meta: { category?: string | null; dryRun?: boolean; fortnoxStatus?: number | null; approvalIds?: string[] } = {},
  ) => {
    const body: Record<string, unknown> = {
      ok: decision === "allowed" || decision === "dry_run",
      decision,
      reason,
      fortnoxCalled: false,
      ...extra,
    };
    await audit(deps, baseAudit({
      requestId,
      agentId: agent?.id ?? null,
      source: "agent",
      method: "POST",
      path: typeof extra.path === "string" ? extra.path : "/",
      category: meta.category ?? null,
      dryRun: meta.dryRun === true,
      decision,
      result: reason,
      reason,
      httpStatus: status,
      fortnoxStatus: meta.fortnoxStatus ?? null,
      approvalIds: meta.approvalIds ?? [],
    }, hash));
    deps.log?.({
      source: "agent",
      agentId: agent?.id ?? null,
      decision,
      reason,
      requestId,
      dryRun: meta.dryRun === true,
    });
    const { path: _path, ...publicBody } = body;
    return json(publicBody, status);
  };

  if (!agent || agent.revokedAt) {
    return reply(401, "unauthorized", "denied");
  }

  let policy;
  try {
    policy = await deps.store.getPolicy();
  } catch {
    return reply(503, "policy_unavailable", "error");
  }
  if (!policy) {
    return reply(503, "policy_unavailable", "error");
  }
  if (policy.globalKillSwitch || agent.killSwitch) {
    return reply(403, "kill_switch", "denied");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return reply(400, "invalid_json", "denied");
  }
  const envelope = parseEnvelope(parsedJson);
  if ("error" in envelope) {
    return reply(400, envelope.error, "denied");
  }

  const route = matchRoute(envelope.method, envelope.path);
  if (!route.ok) {
    return reply(403, route.reason, "denied", { path: envelope.path }, { category: envelope.category, dryRun: envelope.dryRun });
  }

  let archive: { fileName: string; contentType: string; bytes: Uint8Array } | null = null;
  let fortnoxBody: unknown = envelope.body;
  if (route.route.writeClass === "archive") {
    const decoded = decodeArchive(envelope.body);
    if (decoded === "invalid" || decoded === null) {
      return reply(400, "invalid_archive", "denied", { path: envelope.path }, { category: envelope.category, dryRun: envelope.dryRun });
    }
    archive = decoded;
    fortnoxBody = { fileName: archive.fileName, contentType: archive.contentType, bytes: archive.bytes.byteLength };
  }

  if (route.route.kind === "write" && route.route.writeClass) {
    let blocked: number[];
    try {
      blocked = await deps.store.listBlockedAccounts();
    } catch {
      return reply(503, "policy_unavailable", "error", { path: envelope.path }, { category: envelope.category, dryRun: envelope.dryRun });
    }
    const bound = { ...envelope, path: route.path };
    const assessment = assessWrite({
      writeClass: route.route.writeClass,
      category: bound.category,
      transactionDate: bound.transactionDate,
      body: bound.body,
      blocked: new Set(blocked),
      thresholdSek: policy.amountThresholdSek,
      today: stockholmDate(now),
      financialYearStart: policy.financialYearStart,
      financialYearEnd: policy.financialYearEnd,
      requireBodyDate: !bound.path.endsWith("/bookkeep"),
    });
    if (!assessment.ok) {
      return reply(403, assessment.reason, "denied", { path: bound.path }, { category: bound.category, dryRun: bound.dryRun });
    }
    const bodyHash = await payloadHash(bound.body ?? null);
    let approvals: ApprovalRecord[] = [];
    if (bound.approvalIds.length > 0 || assessment.needs.length > 0) {
      const loaded = await loadApprovals(deps.store, bound.approvalIds);
      if (!loaded) {
        return reply(503, "policy_unavailable", "error", { path: bound.path }, { category: bound.category, dryRun: bound.dryRun });
      }
      approvals = loaded;
    }
    const matched = matchApprovals(assessment.needs, approvals, {
      agentId: agent.id,
      category: bound.category ?? "",
      transactionDate: bound.transactionDate,
      payloadHash: bodyHash,
      now,
    });
    if (!matched.ok) {
      return reply(403, matched.reason, "denied", {
        path: bound.path,
        blockedAccounts: assessment.blockedAccounts,
      }, { category: bound.category, dryRun: bound.dryRun });
    }
    if (bound.dryRun) {
      return reply(200, "validated", "dry_run", { path: bound.path }, {
        category: bound.category,
        dryRun: true,
        approvalIds: matched.ids,
      });
    }
    if (matched.ids.length > 0) {
      const consumed = await deps.store.consumeApprovals(matched.ids, agent.id, requestId, now);
      if (!consumed) {
        return reply(403, "approval_conflict", "denied", { path: bound.path }, {
          category: bound.category,
          approvalIds: matched.ids,
        });
      }
    }
    const access = await ensureAccess(deps, now);
    if ("error" in access) {
      return reply(503, access.error, "error", { path: bound.path }, { category: bound.category, approvalIds: matched.ids });
    }
    return callFortnox(deps, agent, requestId, bound, route.route.method, fortnoxBody, archive, access, hash, matched.ids);
  }

  const read = { ...envelope, path: route.path };
  if (read.dryRun) {
    return reply(200, "validated", "dry_run", { path: read.path }, { category: read.category, dryRun: true });
  }
  const access = await ensureAccess(deps, now);
  if ("error" in access) {
    return reply(503, access.error, "error", { path: read.path }, { category: read.category });
  }
  return callFortnox(deps, agent, requestId, read, "GET", null, null, access, hash, []);
}

async function callFortnox(
  deps: GatewayDeps,
  agent: AgentRecord,
  requestId: string,
  envelope: AgentEnvelope,
  method: "GET" | "POST" | "PUT",
  body: unknown,
  archive: { fileName: string; contentType: string; bytes: Uint8Array } | null,
  access: { accessToken: string; secrets: string[] },
  hash: string,
  approvalIds: string[],
): Promise<Response> {
  let result;
  try {
    result = await deps.fortnox.request({
      accessToken: access.accessToken,
      method,
      path: envelope.path,
      query: envelope.query,
      body,
      archive,
    });
  } catch {
    await audit(deps, baseAudit({
      requestId,
      agentId: agent.id,
      source: "agent",
      method,
      path: envelope.path,
      category: envelope.category,
      dryRun: false,
      decision: "error",
      result: "fortnox_unreachable",
      reason: "fortnox_unreachable",
      httpStatus: 502,
      fortnoxStatus: null,
      approvalIds,
    }, hash));
    return json({ ok: false, decision: "error", reason: "fortnox_unreachable", fortnoxCalled: true }, 502);
  }
  const redacted = redact(result.body, access.secrets);
  const ok = result.status >= 200 && result.status < 300;
  await audit(deps, baseAudit({
    requestId,
    agentId: agent.id,
    source: "agent",
    method,
    path: envelope.path,
    category: envelope.category,
    dryRun: false,
    decision: ok ? "allowed" : "fortnox_error",
    result: ok ? "fortnox_ok" : "fortnox_error",
    reason: ok ? "fortnox_ok" : "fortnox_error",
    httpStatus: ok ? 200 : 502,
    fortnoxStatus: result.status,
    approvalIds,
  }, hash));
  deps.log?.({
    source: "agent",
    agentId: agent.id,
    decision: ok ? "allowed" : "fortnox_error",
    path: envelope.path,
    method,
    fortnoxStatus: result.status,
    requestId,
  });
  return json({
    ok,
    decision: ok ? "allowed" : "fortnox_error",
    reason: ok ? "fortnox_ok" : "fortnox_error",
    fortnoxCalled: true,
    fortnoxStatus: result.status,
    body: redacted,
  }, ok ? 200 : 502);
}
