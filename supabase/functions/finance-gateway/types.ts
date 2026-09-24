export type AgentRecord = {
  id: string;
  name: string;
  tokenHash: string;
  revokedAt: string | null;
  killSwitch: boolean;
};

export type ApprovalKind = "ask_account" | "amount_threshold";

export type ApprovalRecord = {
  id: string;
  agentId: string;
  kind: ApprovalKind;
  category: string | null;
  accounts: number[];
  maxAmountSek: number | null;
  transactionDate: string | null;
  payloadHash: string | null;
  expiresAt: string;
  usedAt: string | null;
};

export type PolicyRecord = {
  globalKillSwitch: boolean;
  killSwitchReason: string | null;
  amountThresholdSek: number;
  financialYearStart: string | null;
  financialYearEnd: string | null;
};

export type OauthRecord = {
  accessToken: string | null;
  refreshToken: string;
  accessExpiresAt: string | null;
};

export type AuditEvent = {
  requestId: string;
  agentId: string | null;
  source: "agent" | "admin" | "system";
  method: string;
  path: string;
  payloadHash: string;
  category: string | null;
  dryRun: boolean;
  decision: string;
  result: string;
  reason: string | null;
  httpStatus: number;
  fortnoxStatus: number | null;
  approvalIds: string[];
};

export type CreateApprovalInput = {
  agentId: string;
  kind: ApprovalKind;
  category: string | null;
  accounts: number[];
  maxAmountSek: number | null;
  transactionDate: string | null;
  payloadHash: string | null;
  note: string | null;
  expiresAt: string;
};

export type FinanceStore = {
  getAgentByTokenHash(hash: string): Promise<AgentRecord | null>;
  getPolicy(): Promise<PolicyRecord | null>;
  listBlockedAccounts(): Promise<number[]>;
  getApprovals(ids: string[]): Promise<ApprovalRecord[]>;
  consumeApprovals(ids: string[], agentId: string, requestId: string, now: Date): Promise<boolean>;
  insertAudit(event: AuditEvent): Promise<void>;
  getOauth(): Promise<OauthRecord | null>;
  saveOauth(next: OauthRecord): Promise<void>;
  createAgent(name: string, tokenHash: string): Promise<{ id: string }>;
  revokeAgent(id: string, now: Date): Promise<boolean>;
  setAgentKillSwitch(id: string, engaged: boolean, reason: string | null): Promise<boolean>;
  setGlobalKillSwitch(engaged: boolean, reason: string | null): Promise<void>;
  updatePolicy(patch: { amountThresholdSek?: number; financialYearStart?: string; financialYearEnd?: string }): Promise<void>;
  createApproval(input: CreateApprovalInput): Promise<{ id: string }>;
  listAudit(limit: number): Promise<AuditEvent[]>;
};

export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type FortnoxResult = {
  status: number;
  body: unknown;
};

export type ArchiveUpload = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
};

export type FortnoxClient = {
  refresh(refreshToken: string): Promise<RefreshResult>;
  request(input: {
    accessToken: string;
    method: "GET" | "POST" | "PUT";
    path: string;
    query: Record<string, string>;
    body: unknown;
    archive: ArchiveUpload | null;
  }): Promise<FortnoxResult>;
};
