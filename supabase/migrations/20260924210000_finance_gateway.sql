-- Finance Gateway for Ekonomi-Erik.
--
-- Apply only after this change is reviewed and merged. This file does not
-- connect to a hosted database. It does not read or write Shopify tables.
--
-- Fortnox client credentials stay in Supabase function secrets. The rotated
-- refresh token and access token stay in finance_oauth_tokens. Erik's agent
-- token is stored only as a SHA-256 hash. RLS is enabled and forced, with no
-- policies. anon and authenticated have no grants. The edge function uses the
-- service role, which bypasses RLS. The agent token is not a database role
-- and cannot update policy, approvals, the kill switch, or tokens.

create table public.finance_policy (
  id smallint primary key default 1,
  global_kill_switch boolean not null default true,
  kill_switch_reason text,
  amount_threshold_sek numeric(14, 2) not null default 10000,
  financial_year_start date,
  financial_year_end date,
  updated_at timestamptz not null default now(),
  constraint finance_policy_singleton check (id = 1),
  constraint finance_policy_threshold_nonnegative check (amount_threshold_sek >= 0),
  constraint finance_policy_year_order check (
    financial_year_start is null
    or financial_year_end is null
    or financial_year_start <= financial_year_end
  )
);

comment on table public.finance_policy is
  'Singleton gateway policy. Service role only. The agent token cannot update this row. global_kill_switch defaults to engaged (fail closed). amount_threshold_sek 10000 is a proposed default the owner must confirm.';

insert into public.finance_policy (id, global_kill_switch, kill_switch_reason, amount_threshold_sek)
values (
  1,
  true,
  'Engaged at install. Disengage only after the go-live checklist.',
  10000
);

create table public.finance_blocked_accounts (
  account_number integer primary key,
  reason text not null,
  constraint finance_blocked_accounts_bas check (account_number between 1000 and 9999)
);

comment on table public.finance_blocked_accounts is
  'ASK accounts. A write that references one of these is refused unless a matching one-time approval exists. Ranges must match BLOCKED_ACCOUNT_RANGES in supabase/functions/finance-gateway/blocked_accounts.ts.';

-- Ranges must match blocked_accounts.ts. The drift test reads these generate_series calls.
insert into public.finance_blocked_accounts (account_number, reason)
select n, 'equity' from generate_series(2010, 2099) as n
union all
select n, 'account_2393' from generate_series(2393, 2393) as n
union all
select n, 'tax_liability' from generate_series(2510, 2519) as n
union all
select n, 'payroll_tax' from generate_series(2710, 2799) as n
union all
select n, 'other_liability' from generate_series(2890, 2890) as n
union all
select n, 'other_liability' from generate_series(2893, 2893) as n
union all
select n, 'other_liability' from generate_series(2898, 2898) as n
union all
select n, 'account_1480' from generate_series(1480, 1480) as n
union all
select n, 'tax_account' from generate_series(1630, 1630) as n
union all
select n, 'vat_receivable' from generate_series(1650, 1650) as n
union all
select n, 'vat_liability' from generate_series(2650, 2650) as n
union all
select n, 'personnel_cost' from generate_series(7000, 7699) as n
union all
select n, 'appropriations_tax' from generate_series(8910, 8999) as n;

create table public.finance_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  revoked_at timestamptz,
  kill_switch boolean not null default false,
  kill_switch_reason text,
  created_at timestamptz not null default now(),
  constraint finance_agents_token_hash_hex check (token_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.finance_agents is
  'Ekonomi-Erik and any later agent. token_hash is SHA-256 hex of the bearer token. The plaintext token is returned once by the admin path and is never stored.';

comment on column public.finance_agents.kill_switch is
  'Per-agent kill switch. Engaged means this agent is refused even when the global switch is open.';

create table public.finance_approvals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.finance_agents (id),
  kind text not null,
  category text,
  accounts integer[] not null default '{}',
  max_amount_sek numeric(14, 2),
  transaction_date date,
  payload_hash text,
  note text,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_request_id uuid,
  created_at timestamptz not null default now(),
  constraint finance_approvals_kind check (kind in ('ask_account', 'amount_threshold')),
  constraint finance_approvals_hash check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  constraint finance_approvals_amount check (max_amount_sek is null or max_amount_sek >= 0)
);

comment on table public.finance_approvals is
  'One-time, per-item exceptions. Single-use, expiring, bound to one agent. Writable by the service role admin path only. Cannot waive the allowlist, DELETE ban, settings ban, period rule, or kill switch.';

create index finance_approvals_agent_open_idx
  on public.finance_approvals (agent_id)
  where used_at is null;

create table public.finance_oauth_tokens (
  id smallint primary key default 1,
  access_token text,
  refresh_token text not null,
  access_expires_at timestamptz,
  rotated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_oauth_tokens_singleton check (id = 1),
  constraint finance_oauth_tokens_refresh_present check (char_length(refresh_token) >= 8)
);

comment on table public.finance_oauth_tokens is
  'Fortnox access token and the current refresh token. Fortnox rotates the refresh token on every refresh; the new value must be stored before the next call. Service role only. No seed row in this migration.';

create table public.finance_audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  request_id uuid not null,
  agent_id uuid,
  source text not null,
  method text not null,
  path text not null,
  payload_hash text not null,
  category text,
  dry_run boolean not null default false,
  decision text not null,
  result text not null,
  reason text,
  http_status integer,
  fortnox_status integer,
  approval_ids uuid[] not null default '{}',
  constraint finance_audit_log_source check (source in ('agent', 'admin', 'system')),
  constraint finance_audit_log_hash check (payload_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.finance_audit_log is
  'Append-only log of every gateway call. payload_hash is SHA-256 of the request. Tokens, secrets, and raw Fortnox bodies are not stored.';

create index finance_audit_log_created_at_idx
  on public.finance_audit_log (created_at desc);

create or replace function public.finance_audit_log_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'finance_audit_log is append-only';
end;
$$;

create trigger finance_audit_log_no_update
  before update or delete on public.finance_audit_log
  for each row execute function public.finance_audit_log_append_only();

create trigger finance_audit_log_no_truncate
  before truncate on public.finance_audit_log
  for each statement execute function public.finance_audit_log_append_only();

create or replace function public.finance_consume_approvals(p_ids uuid[], p_agent uuid, p_request uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return true;
  end if;
  if (select count(distinct item) from unnest(p_ids) as item) <> cardinality(p_ids) then
    raise exception 'duplicate approval id';
  end if;

  update public.finance_approvals
  set used_at = clock_timestamp(),
      used_request_id = p_request
  where id = any (p_ids)
    and agent_id = p_agent
    and used_at is null
    and expires_at > clock_timestamp();

  get diagnostics v_count = row_count;
  if v_count <> cardinality(p_ids) then
    raise exception 'approval unavailable';
  end if;
  return true;
end;
$$;

comment on function public.finance_consume_approvals(uuid[], uuid, uuid) is
  'Marks every listed approval used, or raises so the transaction keeps them unused. Service role only.';

create or replace function public.finance_blocked_account_list()
returns integer[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(account_number order by account_number), '{}'::integer[])
  from public.finance_blocked_accounts;
$$;

comment on function public.finance_blocked_account_list() is
  'All ASK account numbers in one value so the edge function is not capped by the API row limit.';

alter table public.finance_policy enable row level security;
alter table public.finance_policy force row level security;
alter table public.finance_blocked_accounts enable row level security;
alter table public.finance_blocked_accounts force row level security;
alter table public.finance_agents enable row level security;
alter table public.finance_agents force row level security;
alter table public.finance_approvals enable row level security;
alter table public.finance_approvals force row level security;
alter table public.finance_oauth_tokens enable row level security;
alter table public.finance_oauth_tokens force row level security;
alter table public.finance_audit_log enable row level security;
alter table public.finance_audit_log force row level security;

revoke all on table public.finance_policy from public, anon, authenticated;
revoke all on table public.finance_blocked_accounts from public, anon, authenticated;
revoke all on table public.finance_agents from public, anon, authenticated;
revoke all on table public.finance_approvals from public, anon, authenticated;
revoke all on table public.finance_oauth_tokens from public, anon, authenticated;
revoke all on table public.finance_audit_log from public, anon, authenticated;

grant select, update on table public.finance_policy to service_role;
grant select on table public.finance_blocked_accounts to service_role;
grant select, insert, update on table public.finance_agents to service_role;
grant select, insert, update on table public.finance_approvals to service_role;
grant select, insert, update on table public.finance_oauth_tokens to service_role;
grant select, insert on table public.finance_audit_log to service_role;

revoke all on function public.finance_audit_log_append_only() from public, anon, authenticated;
revoke all on function public.finance_consume_approvals(uuid[], uuid, uuid) from public, anon, authenticated;
revoke all on function public.finance_blocked_account_list() from public, anon, authenticated;
grant execute on function public.finance_consume_approvals(uuid[], uuid, uuid) to service_role;
grant execute on function public.finance_blocked_account_list() to service_role;
