-- SQL bootstrap for Finance Gateway. Not a migration.
-- Run by hand in the Supabase SQL editor as the service role, after both
-- finance migrations are applied. Do not commit a real token, hash, client
-- secret, or tenant id. This file leaves the kill switch engaged.
--
-- On the operator machine, generate Erik's token once and keep it out of git:
--   TOKEN=$(openssl rand -hex 32)
--   printf 'fg_%s\n' "$TOKEN"
--   printf '%s' "fg_${TOKEN}" | sha256sum | awk '{print $1}'
--   unset TOKEN
-- Give the fg_ line to Erik once. Paste only the 64 hex characters below.

update public.finance_policy
set amount_threshold_sek = 10000,
    financial_year_start = date '2026-01-01',
    financial_year_end = date '2026-12-31',
    global_kill_switch = true,
    kill_switch_reason = 'Engaged until the go-live checklist is done.',
    updated_at = now()
where id = 1;

insert into public.finance_agents (name, token_hash)
values (
  'Ekonomi-Erik',
  'replace-with-sha256-hex-of-the-agent-token'
);

-- The insert fails until the hash is 64 lowercase hex characters. That is
-- intentional. finance_agents.token_hash rejects anything else.

-- Toggle the kill switch. Run only one of these, and run the off statement
-- only after the checklist in README.md is done.
--
-- update public.finance_policy
-- set global_kill_switch = false,
--     kill_switch_reason = 'Go-live',
--     updated_at = now()
-- where id = 1;
--
-- update public.finance_policy
-- set global_kill_switch = true,
--     kill_switch_reason = 'Engaged by operator',
--     updated_at = now()
-- where id = 1;
