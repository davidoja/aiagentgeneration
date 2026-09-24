import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import type {
  AgentRecord,
  ApprovalRecord,
  AuditEvent,
  CreateApprovalInput,
  FinanceStore,
  OauthRecord,
  PolicyRecord,
} from "./types.ts";

export function createServiceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("missing supabase env");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function agentFrom(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    killSwitch: row.kill_switch === true,
  };
}

function approvalFrom(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    kind: row.kind === "amount_threshold" ? "amount_threshold" : "ask_account",
    category: row.category ? String(row.category) : null,
    accounts: Array.isArray(row.accounts) ? row.accounts.map(Number) : [],
    maxAmountSek: row.max_amount_sek === null || row.max_amount_sek === undefined ? null : Number(row.max_amount_sek),
    transactionDate: row.transaction_date ? String(row.transaction_date) : null,
    payloadHash: row.payload_hash ? String(row.payload_hash) : null,
    expiresAt: String(row.expires_at),
    usedAt: row.used_at ? String(row.used_at) : null,
  };
}

function auditFrom(row: Record<string, unknown>): AuditEvent {
  return {
    requestId: String(row.request_id),
    agentId: row.agent_id ? String(row.agent_id) : null,
    source: row.source === "admin" || row.source === "system" ? row.source : "agent",
    method: String(row.method),
    path: String(row.path),
    payloadHash: String(row.payload_hash),
    category: row.category ? String(row.category) : null,
    dryRun: row.dry_run === true,
    decision: String(row.decision),
    result: String(row.result),
    reason: row.reason ? String(row.reason) : null,
    httpStatus: Number(row.http_status),
    fortnoxStatus: row.fortnox_status === null || row.fortnox_status === undefined ? null : Number(row.fortnox_status),
    approvalIds: Array.isArray(row.approval_ids) ? row.approval_ids.map(String) : [],
  };
}

export function createSupabaseFinanceStore(client: SupabaseClient): FinanceStore {
  return {
    async getAgentByTokenHash(hash) {
      const { data, error } = await client.from("finance_agents").select("id,name,token_hash,revoked_at,kill_switch").eq("token_hash", hash).maybeSingle();
      if (error) {
        throw new Error("agent lookup failed");
      }
      return data ? agentFrom(data) : null;
    },
    async getPolicy() {
      const { data, error } = await client.from("finance_policy").select("global_kill_switch,kill_switch_reason,amount_threshold_sek,financial_year_start,financial_year_end").eq("id", 1).maybeSingle();
      if (error) {
        throw new Error("policy lookup failed");
      }
      if (!data) {
        return null;
      }
      return {
        globalKillSwitch: data.global_kill_switch === true,
        killSwitchReason: data.kill_switch_reason ? String(data.kill_switch_reason) : null,
        amountThresholdSek: Number(data.amount_threshold_sek),
        financialYearStart: data.financial_year_start ? String(data.financial_year_start) : null,
        financialYearEnd: data.financial_year_end ? String(data.financial_year_end) : null,
      } satisfies PolicyRecord;
    },
    async listBlockedAccounts() {
      const { data, error } = await client.rpc("finance_blocked_account_list");
      if (error) {
        throw new Error("blocked account lookup failed");
      }
      return Array.isArray(data) ? data.map(Number) : [];
    },
    async getApprovals(ids) {
      if (ids.length === 0) {
        return [];
      }
      const { data, error } = await client.from("finance_approvals").select("id,agent_id,kind,category,accounts,max_amount_sek,transaction_date,payload_hash,expires_at,used_at").in("id", ids);
      if (error) {
        throw new Error("approval lookup failed");
      }
      return (data ?? []).map((row) => approvalFrom(row));
    },
    async consumeApprovals(ids, agentId, requestId) {
      const { data, error } = await client.rpc("finance_consume_approvals", {
        p_ids: ids,
        p_agent: agentId,
        p_request: requestId,
      });
      if (error) {
        return false;
      }
      return data === true;
    },
    async insertAudit(event) {
      const { error } = await client.from("finance_audit_log").insert({
        request_id: event.requestId,
        agent_id: event.agentId,
        source: event.source,
        method: event.method,
        path: event.path,
        payload_hash: event.payloadHash,
        category: event.category,
        dry_run: event.dryRun,
        decision: event.decision,
        result: event.result,
        reason: event.reason,
        http_status: event.httpStatus,
        fortnox_status: event.fortnoxStatus,
        approval_ids: event.approvalIds,
      });
      if (error) {
        throw new Error("audit insert failed");
      }
    },
    async getOauth() {
      const { data, error } = await client.from("finance_oauth_tokens").select("access_token,refresh_token,access_expires_at").eq("id", 1).maybeSingle();
      if (error) {
        throw new Error("oauth lookup failed");
      }
      if (!data?.refresh_token) {
        return null;
      }
      return {
        accessToken: data.access_token ? String(data.access_token) : null,
        refreshToken: String(data.refresh_token),
        accessExpiresAt: data.access_expires_at ? String(data.access_expires_at) : null,
      } satisfies OauthRecord;
    },
    async saveOauth(next) {
      const { error } = await client.from("finance_oauth_tokens").upsert({
        id: 1,
        access_token: next.accessToken,
        refresh_token: next.refreshToken,
        access_expires_at: next.accessExpiresAt,
        rotated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error("oauth persist failed");
      }
    },
    async createAgent(name, tokenHash) {
      const { data, error } = await client.from("finance_agents").insert({ name, token_hash: tokenHash }).select("id").single();
      if (error || !data) {
        throw new Error("agent create failed");
      }
      return { id: String(data.id) };
    },
    async revokeAgent(id, now) {
      const { data, error } = await client.from("finance_agents").update({ revoked_at: now.toISOString() }).eq("id", id).is("revoked_at", null).select("id");
      if (error) {
        throw new Error("agent revoke failed");
      }
      return Array.isArray(data) && data.length === 1;
    },
    async setAgentKillSwitch(id, engaged, reason) {
      const { data, error } = await client.from("finance_agents").update({
        kill_switch: engaged,
        kill_switch_reason: reason,
      }).eq("id", id).select("id");
      if (error) {
        throw new Error("agent kill switch failed");
      }
      return Array.isArray(data) && data.length === 1;
    },
    async setGlobalKillSwitch(engaged, reason) {
      const { error } = await client.from("finance_policy").update({
        global_kill_switch: engaged,
        kill_switch_reason: reason,
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
      if (error) {
        throw new Error("kill switch update failed");
      }
    },
    async updatePolicy(patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.amountThresholdSek !== undefined) {
        row.amount_threshold_sek = patch.amountThresholdSek;
      }
      if (patch.financialYearStart !== undefined) {
        row.financial_year_start = patch.financialYearStart;
      }
      if (patch.financialYearEnd !== undefined) {
        row.financial_year_end = patch.financialYearEnd;
      }
      const { error } = await client.from("finance_policy").update(row).eq("id", 1);
      if (error) {
        throw new Error("policy update failed");
      }
    },
    async createApproval(input: CreateApprovalInput) {
      const { data, error } = await client.from("finance_approvals").insert({
        agent_id: input.agentId,
        kind: input.kind,
        category: input.category,
        accounts: input.accounts,
        max_amount_sek: input.maxAmountSek,
        transaction_date: input.transactionDate,
        payload_hash: input.payloadHash,
        note: input.note,
        expires_at: input.expiresAt,
      }).select("id").single();
      if (error || !data) {
        throw new Error("approval create failed");
      }
      return { id: String(data.id) };
    },
    async listAudit(limit) {
      const { data, error } = await client.from("finance_audit_log").select("request_id,agent_id,source,method,path,payload_hash,category,dry_run,decision,result,reason,http_status,fortnox_status,approval_ids,created_at").order("created_at", { ascending: false }).limit(limit);
      if (error) {
        throw new Error("audit list failed");
      }
      return (data ?? []).map((row) => auditFrom(row));
    },
  };
}
