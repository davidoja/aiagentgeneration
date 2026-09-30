-- Shopify order and customer sync for Sultan AB.
--
-- Apply only after review, and only on the Supabase database that already
-- contains public.apify_local_business_leads (domain, emails,
-- company_domain_emails, normalized_name). This migration does not create,
-- alter, or backfill that table.
--
-- The leads primary key type is not defined in this repo, so matches are
-- stored as text (uuid or bigint both round-trip) with no foreign key.
--
-- raw_payload is kept so a later mapping change can be replayed from the
-- webhook document Shopify will not resend. It contains customer PII.
-- Integers of 16+ digits are stored as JSON strings so they are not rounded.
-- RLS is enabled and forced, with no policies. anon/authenticated have no
-- grants. The edge function reads and writes with the service role, which
-- bypasses RLS.

create table public.shopify_customers (
  shopify_customer_id bigint primary key,
  email text,
  customer_name text,
  company_name text,
  country text,
  barber_lead_id text,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  raw_payload jsonb,
  synced_at timestamptz not null default now()
);

comment on table public.shopify_customers is
  'Shopify customers from customers/create and from orders. Service role only.';

comment on column public.shopify_customers.barber_lead_id is
  'Text form of apify_local_business_leads.id. Nullable. No FK because that table is not created here and its id type is not in the repo.';

comment on column public.shopify_customers.raw_payload is
  'Webhook customer JSON (PII). Nullable. Kept for remapping. RLS, no policies.';

create table public.shopify_orders (
  shopify_order_id bigint primary key,
  order_number bigint,
  order_name text,
  shopify_customer_id bigint references public.shopify_customers (shopify_customer_id) on delete set null,
  shopify_created_at timestamptz,
  paid_at timestamptz,
  financial_status text,
  currency text,
  total_price numeric,
  subtotal_price numeric,
  total_tax numeric,
  total_discounts numeric,
  customer_email text,
  customer_name text,
  company_name text,
  shipping_country text,
  billing_country text,
  line_items jsonb not null default '[]'::jsonb,
  raw_payload jsonb,
  barber_lead_id text,
  synced_at timestamptz not null default now(),
  constraint shopify_orders_line_items_array check (jsonb_typeof(line_items) = 'array')
);

comment on table public.shopify_orders is
  'Shopify orders. shopify_order_id is the idempotent upsert key. Service role only.';

comment on column public.shopify_orders.paid_at is
  'Set from the webhook when the topic is orders/paid or financial_status is paid. Shopify REST orders have no paid_at field.';

comment on column public.shopify_orders.barber_lead_id is
  'Text form of apify_local_business_leads.id. Nullable. No FK; see shopify_customers.barber_lead_id.';

comment on column public.shopify_orders.raw_payload is
  'Webhook order JSON (PII), with 16+ digit integers as strings. Nullable. RLS, no policies.';

comment on column public.shopify_orders.line_items is
  'Reduced line-item list (id, product, variant, title, sku, quantity, price). The full objects remain in raw_payload.';

create index shopify_customers_email_idx
  on public.shopify_customers (email);

create index shopify_customers_barber_lead_id_idx
  on public.shopify_customers (barber_lead_id);

create index shopify_orders_customer_email_idx
  on public.shopify_orders (customer_email);

create index shopify_orders_barber_lead_id_idx
  on public.shopify_orders (barber_lead_id);

create index shopify_orders_shopify_customer_id_idx
  on public.shopify_orders (shopify_customer_id);

alter table public.shopify_customers enable row level security;
alter table public.shopify_customers force row level security;
alter table public.shopify_orders enable row level security;
alter table public.shopify_orders force row level security;

revoke all on table public.shopify_customers from public, anon, authenticated;
revoke all on table public.shopify_orders from public, anon, authenticated;
grant select, insert, update, delete on table public.shopify_customers to service_role;
grant select, insert, update, delete on table public.shopify_orders to service_role;

-- Coarse candidate lookup. Exact email vs domain is decided in the edge
-- function (supabase/functions/_shared/match.ts), which also drops free-mail
-- domains. strpos is used so text, text[], and jsonb email columns all match
-- without interpolating the address into dynamic SQL.
create or replace function public.shopify_barber_lead_candidates(p_email text, p_domain text)
returns table (
  id text,
  domain text,
  emails jsonb,
  company_domain_emails jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with input as (
    select
      lower(btrim(coalesce(p_email, ''))) as email,
      lower(btrim(coalesce(p_domain, ''))) as domain
  ),
  email_hits as (
    select
      l.id::text as id,
      l.domain::text as domain,
      case
        when l.emails is null then '[]'::jsonb
        else to_jsonb(l.emails)
      end as emails,
      case
        when l.company_domain_emails is null then '[]'::jsonb
        else to_jsonb(l.company_domain_emails)
      end as company_domain_emails
    from public.apify_local_business_leads l
    cross join input i
    where i.email <> ''
      and position('@' in i.email) > 0
      and (
        strpos(lower(l.emails::text), i.email) > 0
        or strpos(lower(l.company_domain_emails::text), i.email) > 0
      )
    limit 25
  ),
  domain_hits as (
    select
      l.id::text as id,
      l.domain::text as domain,
      case
        when l.emails is null then '[]'::jsonb
        else to_jsonb(l.emails)
      end as emails,
      case
        when l.company_domain_emails is null then '[]'::jsonb
        else to_jsonb(l.company_domain_emails)
      end as company_domain_emails
    from public.apify_local_business_leads l
    cross join input i
    where i.domain <> ''
      and position('.' in i.domain) > 0
      and position('@' in i.domain) = 0
      and (
        strpos(lower(coalesce(l.domain::text, '')), i.domain) > 0
        or strpos(lower(coalesce(l.company_domain_emails::text, '')), '@' || i.domain) > 0
      )
    limit 50
  )
  select * from email_hits
  union
  select * from domain_hits;
$$;

comment on function public.shopify_barber_lead_candidates(text, text) is
  'Service-role candidate rows from apify_local_business_leads. Matching rules live in the edge function.';

revoke all on function public.shopify_barber_lead_candidates(text, text) from public, anon, authenticated;
grant execute on function public.shopify_barber_lead_candidates(text, text) to service_role;

create or replace function public.upsert_shopify_customer(p jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p->>'shopify_customer_id' is null or p->>'shopify_customer_id' !~ '^[0-9]+$' then
    raise exception 'invalid shopify customer id';
  end if;

  insert into public.shopify_customers (
    shopify_customer_id,
    email,
    customer_name,
    company_name,
    country,
    barber_lead_id,
    shopify_created_at,
    shopify_updated_at,
    raw_payload
  ) values (
    (p->>'shopify_customer_id')::bigint,
    nullif(p->>'email', ''),
    nullif(p->>'customer_name', ''),
    nullif(p->>'company_name', ''),
    nullif(p->>'country', ''),
    nullif(p->>'barber_lead_id', ''),
    nullif(p->>'shopify_created_at', '')::timestamptz,
    nullif(p->>'shopify_updated_at', '')::timestamptz,
    p->'raw_payload'
  )
  on conflict (shopify_customer_id) do update set
    email = coalesce(excluded.email, public.shopify_customers.email),
    customer_name = coalesce(excluded.customer_name, public.shopify_customers.customer_name),
    company_name = coalesce(excluded.company_name, public.shopify_customers.company_name),
    country = coalesce(excluded.country, public.shopify_customers.country),
    barber_lead_id = coalesce(excluded.barber_lead_id, public.shopify_customers.barber_lead_id),
    shopify_created_at = coalesce(excluded.shopify_created_at, public.shopify_customers.shopify_created_at),
    shopify_updated_at = coalesce(excluded.shopify_updated_at, public.shopify_customers.shopify_updated_at),
    raw_payload = coalesce(excluded.raw_payload, public.shopify_customers.raw_payload),
    synced_at = now();
end;
$$;

revoke all on function public.upsert_shopify_customer(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_shopify_customer(jsonb) to service_role;

create or replace function public.upsert_shopify_order(p jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_line_items jsonb := case
    when jsonb_typeof(p->'line_items') = 'array' then p->'line_items'
    else '[]'::jsonb
  end;
begin
  if p->>'shopify_order_id' is null or p->>'shopify_order_id' !~ '^[0-9]+$' then
    raise exception 'invalid shopify order id';
  end if;

  if p->>'shopify_customer_id' is not null
     and p->>'shopify_customer_id' !~ '^[0-9]+$' then
    raise exception 'invalid shopify customer id';
  end if;

  insert into public.shopify_orders (
    shopify_order_id,
    order_number,
    order_name,
    shopify_customer_id,
    shopify_created_at,
    paid_at,
    financial_status,
    currency,
    total_price,
    subtotal_price,
    total_tax,
    total_discounts,
    customer_email,
    customer_name,
    company_name,
    shipping_country,
    billing_country,
    line_items,
    raw_payload,
    barber_lead_id
  ) values (
    (p->>'shopify_order_id')::bigint,
    nullif(p->>'order_number', '')::bigint,
    nullif(p->>'order_name', ''),
    nullif(p->>'shopify_customer_id', '')::bigint,
    nullif(p->>'shopify_created_at', '')::timestamptz,
    nullif(p->>'paid_at', '')::timestamptz,
    nullif(p->>'financial_status', ''),
    nullif(p->>'currency', ''),
    nullif(p->>'total_price', '')::numeric,
    nullif(p->>'subtotal_price', '')::numeric,
    nullif(p->>'total_tax', '')::numeric,
    nullif(p->>'total_discounts', '')::numeric,
    nullif(p->>'customer_email', ''),
    nullif(p->>'customer_name', ''),
    nullif(p->>'company_name', ''),
    nullif(p->>'shipping_country', ''),
    nullif(p->>'billing_country', ''),
    v_line_items,
    p->'raw_payload',
    nullif(p->>'barber_lead_id', '')
  )
  on conflict (shopify_order_id) do update set
    order_number = coalesce(excluded.order_number, public.shopify_orders.order_number),
    order_name = coalesce(excluded.order_name, public.shopify_orders.order_name),
    shopify_customer_id = coalesce(excluded.shopify_customer_id, public.shopify_orders.shopify_customer_id),
    shopify_created_at = coalesce(excluded.shopify_created_at, public.shopify_orders.shopify_created_at),
    paid_at = coalesce(excluded.paid_at, public.shopify_orders.paid_at),
    financial_status = coalesce(excluded.financial_status, public.shopify_orders.financial_status),
    currency = coalesce(excluded.currency, public.shopify_orders.currency),
    total_price = coalesce(excluded.total_price, public.shopify_orders.total_price),
    subtotal_price = coalesce(excluded.subtotal_price, public.shopify_orders.subtotal_price),
    total_tax = coalesce(excluded.total_tax, public.shopify_orders.total_tax),
    total_discounts = coalesce(excluded.total_discounts, public.shopify_orders.total_discounts),
    customer_email = coalesce(excluded.customer_email, public.shopify_orders.customer_email),
    customer_name = coalesce(excluded.customer_name, public.shopify_orders.customer_name),
    company_name = coalesce(excluded.company_name, public.shopify_orders.company_name),
    shipping_country = coalesce(excluded.shipping_country, public.shopify_orders.shipping_country),
    billing_country = coalesce(excluded.billing_country, public.shopify_orders.billing_country),
    line_items = case
      when excluded.line_items = '[]'::jsonb then public.shopify_orders.line_items
      else excluded.line_items
    end,
    raw_payload = coalesce(excluded.raw_payload, public.shopify_orders.raw_payload),
    barber_lead_id = coalesce(excluded.barber_lead_id, public.shopify_orders.barber_lead_id),
    synced_at = now();
end;
$$;

revoke all on function public.upsert_shopify_order(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_shopify_order(jsonb) to service_role;
