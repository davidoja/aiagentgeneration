-- Client-credentials cache for Finance Gateway.
--
-- Apply after 20260924210000_finance_gateway.sql, and only after review.
-- This file does not seed secrets, access tokens, or a tenant id. It does not
-- grant anon or authenticated. RLS stays forced from the previous migration.
-- The kill switch stays engaged. The audit log stays append-only.

alter table public.finance_oauth_tokens
  alter column refresh_token drop not null;

alter table public.finance_oauth_tokens
  add column token_kind text not null default 'refresh';

alter table public.finance_oauth_tokens
  drop constraint finance_oauth_tokens_refresh_present;

alter table public.finance_oauth_tokens
  add constraint finance_oauth_tokens_token_kind
  check (token_kind in ('refresh', 'client_credentials'));

alter table public.finance_oauth_tokens
  add constraint finance_oauth_tokens_refresh_shape
  check (
    (
      token_kind = 'refresh'
      and refresh_token is not null
      and char_length(refresh_token) >= 8
    )
    or (
      token_kind = 'client_credentials'
      and refresh_token is null
    )
  );

comment on column public.finance_oauth_tokens.token_kind is
  'refresh: authorization-code fallback, refresh_token required. client_credentials: access token cached for FORTNOX_TENANT_ID, refresh_token must stay null.';

comment on table public.finance_oauth_tokens is
  'Fortnox access-token cache. Client-credentials mode stores no refresh token. Refresh mode stores the current rotated refresh token. Service role only.';
