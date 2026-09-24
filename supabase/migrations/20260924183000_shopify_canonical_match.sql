-- Additive follow-up for the Shopify sync.
-- Does not drop or truncate anything, and does not change RLS on existing
-- tables. barbers, organizations, contacts, outreach_sends, outreach_events,
-- organization_identifiers, organization_contacts, locations, and
-- apify_local_business_leads must already exist.

alter table public.shopify_customers
  add column if not exists contact_id uuid references public.contacts (id) on delete set null,
  add column if not exists barber_id uuid references public.barbers (id) on delete set null,
  add column if not exists organization_id uuid references public.organizations (id) on delete set null;

alter table public.shopify_orders
  add column if not exists contact_id uuid references public.contacts (id) on delete set null,
  add column if not exists barber_id uuid references public.barbers (id) on delete set null,
  add column if not exists organization_id uuid references public.organizations (id) on delete set null;

comment on column public.shopify_orders.barber_id is
  'Matched public.barbers.id. Customer means barbers.status = customer.';
comment on column public.shopify_orders.organization_id is
  'Matched public.organizations.id. Customer means lifecycle_status = customer.';
comment on column public.shopify_orders.contact_id is
  'public.contacts.id from find/upsert_contact. Not a second contact row.';
comment on column public.shopify_orders.barber_lead_id is
  'Optional text copy of apify_local_business_leads.id when that lead email matches. Canonical links are the uuid foreign keys.';

create index if not exists shopify_orders_barber_id_idx
  on public.shopify_orders (barber_id);
create index if not exists shopify_orders_organization_id_idx
  on public.shopify_orders (organization_id);
create index if not exists shopify_orders_contact_id_idx
  on public.shopify_orders (contact_id);
create index if not exists shopify_customers_barber_id_idx
  on public.shopify_customers (barber_id);
create index if not exists shopify_customers_organization_id_idx
  on public.shopify_customers (organization_id);
create index if not exists shopify_customers_contact_id_idx
  on public.shopify_customers (contact_id);

-- One conversion event per Shopify order. Other event types are untouched.
create unique index if not exists outreach_events_converted_order_external_id_uidx
  on public.outreach_events (external_id)
  where event_type = 'converted_order' and external_id is not null;

create or replace function public.shopify_uuid_or_null(p_value text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  if btrim(p_value) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return btrim(p_value)::uuid;
exception
  when others then
    return null;
end;
$$;

revoke all on function public.shopify_uuid_or_null(text) from public, anon, authenticated;
grant execute on function public.shopify_uuid_or_null(text) to service_role;

create or replace function public.shopify_is_free_mail_domain(p_domain text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_domain is null or btrim(p_domain) = '' then false
    when lower(btrim(p_domain)) in ('web.de', 'me.com', 'mac.com') then true
    when split_part(lower(btrim(p_domain)), '.', 1) in (
      'gmail', 'googlemail', 'gmx', 'outlook', 'hotmail', 'yahoo', 'icloud', 't-online'
    ) then true
    else false
  end;
$$;

revoke all on function public.shopify_is_free_mail_domain(text) from public, anon, authenticated;
grant execute on function public.shopify_is_free_mail_domain(text) to service_role;

create or replace function public.match_shopify_party(p_email text, p_company text, p_country text)
returns table (
  contact_id uuid,
  barber_id uuid,
  organization_id uuid,
  apify_lead_id uuid,
  match_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_company text := nullif(lower(regexp_replace(btrim(coalesce(p_company, '')), '\s+', ' ', 'g')), '');
  v_country text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_domain text;
  v_contact uuid;
  v_barber uuid;
  v_org uuid;
  v_apify uuid;
  v_reason text := 'none';
  v_count integer;
  v_barber_count integer := 0;
  v_barber_org uuid;
begin
  if v_email is not null and position('@' in v_email) > 1 then
    select c.id into v_contact
    from public.contacts c
    where c.email is not null
      and lower(c.email::text) = v_email
    limit 1;

    select count(*) into v_barber_count
    from public.barbers b
    where b.email is not null
      and lower(b.email) = v_email;

    select count(*) into v_count
    from public.apify_local_business_leads l
    where exists (
      select 1
      from regexp_split_to_table(
        lower(coalesce(l.emails, '') || ',' || coalesce(l.company_domain_emails, '')),
        '[,;[:space:]]+'
      ) as token
      where btrim(token) = v_email
    );
    if v_count = 1 then
      select l.id into v_apify
      from public.apify_local_business_leads l
      where exists (
        select 1
        from regexp_split_to_table(
          lower(coalesce(l.emails, '') || ',' || coalesce(l.company_domain_emails, '')),
          '[,;[:space:]]+'
        ) as token
        where btrim(token) = v_email
      );
    end if;

    if v_barber_count > 1 then
      contact_id := v_contact;
      barber_id := null;
      organization_id := null;
      apify_lead_id := v_apify;
      match_reason := 'none';
      return next;
      return;
    end if;

    if v_barber_count = 1 then
      select b.id, b.organization_id into v_barber, v_org
      from public.barbers b
      where b.email is not null
        and lower(b.email) = v_email;
      contact_id := v_contact;
      barber_id := v_barber;
      organization_id := v_org;
      apify_lead_id := v_apify;
      match_reason := 'email';
      return next;
      return;
    end if;

    if v_contact is not null then
      v_reason := 'email';
      select count(distinct oc.organization_id) into v_count
      from public.organization_contacts oc
      where oc.contact_id = v_contact;
      if v_count = 1 then
        select oc.organization_id into v_org
        from public.organization_contacts oc
        where oc.contact_id = v_contact
        limit 1;
      end if;
    end if;
  end if;

  v_domain := case
    when v_email is null then null
    else public.normalize_domain(split_part(v_email, '@', 2))
  end;

  if v_barber is null and v_org is null and v_domain is not null
     and not public.shopify_is_free_mail_domain(v_domain) then
    select count(distinct hit.id) into v_count
    from (
      select o.id
      from public.organizations o
      where public.normalize_domain(o.website_url) = v_domain
      union
      select i.organization_id
      from public.organization_identifiers i
      where i.identifier_type = 'domain'
        and i.normalized_value = v_domain
    ) as hit;

    if v_count = 1 then
      select hit.id into v_org
      from (
        select o.id
        from public.organizations o
        where public.normalize_domain(o.website_url) = v_domain
        union
        select i.organization_id
        from public.organization_identifiers i
        where i.identifier_type = 'domain'
          and i.normalized_value = v_domain
      ) as hit;
      if v_reason = 'none' then
        v_reason := 'domain';
      end if;
      select count(*) into v_count
      from public.barbers b
      where b.organization_id = v_org;
      if v_count = 1 then
        select b.id into v_barber
        from public.barbers b
        where b.organization_id = v_org;
      end if;
      contact_id := v_contact;
      barber_id := v_barber;
      organization_id := v_org;
      apify_lead_id := v_apify;
      match_reason := v_reason;
      return next;
      return;
    end if;
  end if;

  if v_barber is not null or v_org is not null then
    contact_id := v_contact;
    barber_id := v_barber;
    organization_id := v_org;
    apify_lead_id := v_apify;
    match_reason := v_reason;
    return next;
    return;
  end if;

  if v_company is null or char_length(v_company) < 2 or v_country is null then
    contact_id := v_contact;
    barber_id := null;
    organization_id := null;
    apify_lead_id := v_apify;
    match_reason := v_reason;
    return next;
    return;
  end if;

  select count(*) into v_count
  from public.barbers b
  where lower(regexp_replace(btrim(b.name), '\s+', ' ', 'g')) = v_company
    and upper(btrim(b.country)) = v_country;

  if v_count = 1 then
    select b.id, b.organization_id into v_barber, v_barber_org
    from public.barbers b
    where lower(regexp_replace(btrim(b.name), '\s+', ' ', 'g')) = v_company
      and upper(btrim(b.country)) = v_country;
  elsif v_count > 1 then
    contact_id := v_contact;
    barber_id := null;
    organization_id := null;
    apify_lead_id := v_apify;
    match_reason := v_reason;
    return next;
    return;
  end if;

  select count(distinct o.id) into v_count
  from public.organizations o
  join public.locations l on l.organization_id = o.id
  where (
      lower(regexp_replace(btrim(o.display_name), '\s+', ' ', 'g')) = v_company
      or lower(regexp_replace(btrim(coalesce(o.legal_name, '')), '\s+', ' ', 'g')) = v_company
    )
    and upper(btrim(l.country_code)) = v_country;

  if v_count = 1 then
    select distinct o.id into v_org
    from public.organizations o
    join public.locations l on l.organization_id = o.id
    where (
        lower(regexp_replace(btrim(o.display_name), '\s+', ' ', 'g')) = v_company
        or lower(regexp_replace(btrim(coalesce(o.legal_name, '')), '\s+', ' ', 'g')) = v_company
      )
      and upper(btrim(l.country_code)) = v_country;
  elsif v_count > 1 then
    contact_id := v_contact;
    barber_id := null;
    organization_id := null;
    apify_lead_id := v_apify;
    match_reason := v_reason;
    return next;
    return;
  end if;

  if v_barber is not null and v_org is not null and v_barber_org is not null and v_barber_org is distinct from v_org then
    contact_id := v_contact;
    barber_id := null;
    organization_id := null;
    apify_lead_id := v_apify;
    match_reason := v_reason;
    return next;
    return;
  end if;

  if v_barber is not null or v_org is not null then
    if v_reason = 'none' then
      v_reason := 'company';
    end if;
    if v_barber is not null and v_org is null then
      v_org := v_barber_org;
    end if;
    if v_barber is null and v_org is not null then
      select count(*) into v_count
      from public.barbers b
      where b.organization_id = v_org;
      if v_count = 1 then
        select b.id into v_barber
        from public.barbers b
        where b.organization_id = v_org;
      end if;
    end if;
  end if;

  contact_id := v_contact;
  barber_id := v_barber;
  organization_id := v_org;
  apify_lead_id := v_apify;
  match_reason := v_reason;
  return next;
end;
$$;

revoke all on function public.match_shopify_party(text, text, text) from public, anon, authenticated;
grant execute on function public.match_shopify_party(text, text, text) to service_role;

create or replace function public.record_shopify_outreach_conversion(
  p_email text,
  p_order_id text,
  p_amount text,
  p_currency text,
  p_barber_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_send uuid;
begin
  if v_email is null or p_order_id is null or p_order_id !~ '^[0-9]+$' then
    return false;
  end if;

  select s.id into v_send
  from public.outreach_sends s
  where lower(s.recipient_email) = v_email
    and s.sent_at >= now() - interval '90 days'
  order by s.sent_at desc
  limit 1;

  if v_send is null then
    return false;
  end if;

  begin
    insert into public.outreach_events (
      send_id,
      event_type,
      occurred_at,
      source_system,
      external_id,
      metadata
    ) values (
      v_send,
      'converted_order',
      now(),
      'shopify',
      p_order_id,
      jsonb_strip_nulls(jsonb_build_object(
        'shopify_order_id', p_order_id,
        'amount', nullif(p_amount, ''),
        'currency', nullif(p_currency, '')
      ))
    );
  exception
    when unique_violation then
      null;
  end;

  if p_barber_id is not null then
    update public.barbers
    set status = 'customer', updated_at = now()
    where id = p_barber_id
      and status not in ('customer', 'partner');
  end if;

  if p_organization_id is not null then
    update public.organizations
    set lifecycle_status = 'customer', updated_at = now()
    where id = p_organization_id
      and lifecycle_status not in ('customer', 'partner');
  end if;

  return true;
end;
$$;

revoke all on function public.record_shopify_outreach_conversion(text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_shopify_outreach_conversion(text, text, text, text, uuid, uuid) to service_role;

create or replace function public.upsert_shopify_customer(p jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_contact uuid := public.shopify_uuid_or_null(p->>'contact_id');
  v_barber uuid := public.shopify_uuid_or_null(p->>'barber_id');
  v_org uuid := public.shopify_uuid_or_null(p->>'organization_id');
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
    contact_id,
    barber_id,
    organization_id,
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
    v_contact,
    v_barber,
    v_org,
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
    contact_id = coalesce(excluded.contact_id, public.shopify_customers.contact_id),
    barber_id = coalesce(excluded.barber_id, public.shopify_customers.barber_id),
    organization_id = coalesce(excluded.organization_id, public.shopify_customers.organization_id),
    barber_lead_id = coalesce(excluded.barber_lead_id, public.shopify_customers.barber_lead_id),
    shopify_created_at = coalesce(excluded.shopify_created_at, public.shopify_customers.shopify_created_at),
    shopify_updated_at = coalesce(excluded.shopify_updated_at, public.shopify_customers.shopify_updated_at),
    raw_payload = coalesce(excluded.raw_payload, public.shopify_customers.raw_payload),
    synced_at = now();
end;
$$;

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
  v_contact uuid := public.shopify_uuid_or_null(p->>'contact_id');
  v_barber uuid := public.shopify_uuid_or_null(p->>'barber_id');
  v_org uuid := public.shopify_uuid_or_null(p->>'organization_id');
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
    contact_id,
    barber_id,
    organization_id,
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
    v_contact,
    v_barber,
    v_org,
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
    contact_id = coalesce(excluded.contact_id, public.shopify_orders.contact_id),
    barber_id = coalesce(excluded.barber_id, public.shopify_orders.barber_id),
    organization_id = coalesce(excluded.organization_id, public.shopify_orders.organization_id),
    barber_lead_id = coalesce(excluded.barber_lead_id, public.shopify_orders.barber_lead_id),
    synced_at = now();
end;
$$;

-- Existing columns stay in the same order. Conversions are appended.
-- security_invoker stays on. score_30d is unchanged.
create or replace view public.v_outreach_perf_30d
with (security_invoker = on) as
with decayed_sends as (
  select
    s.id,
    s.template_code,
    s.segment,
    s.city,
    s.product_angle,
    extract(epoch from now() - s.sent_at) / 86400.0 as age_days,
    power(0.5::double precision, (extract(epoch from now() - s.sent_at) / 86400.0 / 7.0)::double precision) as w
  from public.outreach_sends s
  where s.sent_at >= (now() - '30 days'::interval)
    and s.send_status = any (array['sent'::text, 'bounced'::text])
),
send_rollup as (
  select
    decayed_sends.template_code,
    decayed_sends.segment,
    decayed_sends.city,
    decayed_sends.product_angle,
    count(*) as sends_30d,
    sum(decayed_sends.w) as weighted_sends
  from decayed_sends
  group by decayed_sends.template_code, decayed_sends.segment, decayed_sends.city, decayed_sends.product_angle
),
event_rollup as (
  select
    d.template_code,
    d.segment,
    d.city,
    d.product_angle,
    count(*) filter (where e.event_type = 'replied'::text) as replies,
    count(*) filter (where e.event_type = 'positive'::text) as positives,
    count(*) filter (where e.event_type = 'meeting_booked'::text) as meetings,
    count(*) filter (where e.event_type = any (array['negative'::text, 'closed_lost'::text, 'unsub'::text, 'bounce'::text])) as negatives,
    sum(d.w) filter (where e.event_type = 'replied'::text) as weighted_replies,
    sum(d.w) filter (where e.event_type = 'positive'::text) as weighted_positives,
    sum(d.w) filter (where e.event_type = 'meeting_booked'::text) as weighted_meetings,
    sum(d.w) filter (where e.event_type = any (array['negative'::text, 'closed_lost'::text, 'unsub'::text, 'bounce'::text])) as weighted_negatives,
    count(*) filter (where e.event_type = 'converted_order'::text) as conversions,
    sum(d.w) filter (where e.event_type = 'converted_order'::text) as weighted_conversions
  from decayed_sends d
  left join public.outreach_events e on e.send_id = d.id
  group by d.template_code, d.segment, d.city, d.product_angle
),
rates as (
  select
    sr.template_code,
    sr.segment,
    sr.city,
    sr.product_angle,
    sr.sends_30d,
    sr.weighted_sends,
    coalesce(er.replies, 0::bigint) as replies,
    coalesce(er.positives, 0::bigint) as positives,
    coalesce(er.meetings, 0::bigint) as meetings,
    coalesce(er.negatives, 0::bigint) as negatives,
    coalesce(er.weighted_replies, 0::double precision) / nullif(sr.weighted_sends, 0::double precision) as reply_rate,
    coalesce(er.weighted_positives, 0::double precision) / nullif(sr.weighted_sends, 0::double precision) as pos_rate,
    coalesce(er.weighted_meetings, 0::double precision) / nullif(sr.weighted_sends, 0::double precision) as meet_rate,
    coalesce(er.weighted_negatives, 0::double precision) / nullif(sr.weighted_sends, 0::double precision) as neg_rate,
    coalesce(er.conversions, 0::bigint) as conversions,
    coalesce(er.weighted_conversions, 0::double precision) as weighted_conversions,
    coalesce(er.weighted_conversions, 0::double precision) / nullif(sr.weighted_sends, 0::double precision) as conversion_rate
  from send_rollup sr
  left join event_rollup er
    on er.template_code = sr.template_code
   and er.segment is not distinct from sr.segment
   and er.city is not distinct from sr.city
   and er.product_angle is not distinct from sr.product_angle
)
select
  template_code,
  segment,
  city,
  product_angle,
  sends_30d,
  weighted_sends,
  replies,
  positives,
  meetings,
  negatives,
  reply_rate,
  pos_rate,
  meet_rate,
  neg_rate,
  3::double precision * pos_rate
    + 5::double precision * meet_rate
    + 1::double precision * reply_rate
    - 2::double precision * neg_rate as score_30d,
  conversions,
  weighted_conversions,
  conversion_rate
from rates;
