# Shopify to Supabase sync

Pulls Sultan AB Shopify orders and customers into Supabase and links them to existing barber leads. The Express app in this repo is unchanged. This path is a Supabase Edge Function plus two tables.

Nothing in this repository deploys the function, applies the migration, or registers Shopify webhooks. David runs the steps below only after this change is reviewed and merged.

## What is stored

`public.shopify_orders` (primary key `shopify_order_id`, so a retry updates the same row):

- order number and Shopify order name
- Shopify created time and paid time
- financial status, currency, total, subtotal, tax, discounts
- customer email, customer name, company name
- shipping and billing country
- line items as JSON
- optional raw webhook JSON
- nullable `barber_lead_id`

`public.shopify_customers` exists because `customers/create` has no order to hang the customer on. Orders that include a customer id upsert that customer first, then the order.

`raw_payload` is included so a mapping fix can be replayed from the webhook Shopify will not send again. The column holds names, email, and addresses. Integers of 16 or more digits are stored as JSON strings so JavaScript does not round Shopify ids. Leave the column null later if you would rather not keep the full document.

## Security model

- Shopify signs the raw body with HMAC-SHA256 (`X-Shopify-Hmac-Sha256`). The function compares the MAC bytes in constant time. A missing or invalid signature returns 401 and does not read or write the database.
- Deploy this function with JWT verification **disabled**. Shopify cannot send a Supabase JWT. The HMAC secret is the authentication check. With JWT verification off, the URL is reachable without a Supabase key, so the HMAC check is mandatory.
- Row level security is enabled and forced on both tables. There are no policies. `anon` and `authenticated` have no grants, so the Data API does not expose the tables. The function uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS. The SQL editor, running as the database owner, can still read the rows.
- Logs include the topic and Shopify ids only. They do not include the body, email, name, or address.
- Secrets are environment variables. This repo does not contain a project ref, service role key, webhook secret, or customer data.

## Barber matching

Leads stay in the existing table `public.apify_local_business_leads` (`domain`, `emails`, `company_domain_emails`, `normalized_name`). This repo does not create that table. There is no other barber or customer table in the repository.

1. Exact email, case-insensitive, against `emails` and `company_domain_emails`.
2. Otherwise the customer's email domain, against `domain` and the domains in `company_domain_emails`.
3. Free-mail domains are not used for step 2. An exact free-mail address can still match step 1.

Free-mail means the first DNS label is `gmail`, `googlemail`, `gmx`, `outlook`, `hotmail`, `yahoo`, `icloud`, or `t-online`, plus the exact domains `web.de`, `me.com`, and `mac.com`. `live.com`, `msn.com`, `aol.com`, and `proton.me` are not excluded. The list lives in `supabase/functions/_shared/match.ts`.

If more than one lead matches the same email or the same domain, the order is left unmatched.

`barber_lead_id` is `text`, not a foreign key. The leads primary key type is not defined in this repo. A uuid and a bigint both store cleanly. Tighten it to a real foreign key after confirming `apify_local_business_leads.id`.

Names are not matched. `normalized_name` is intentionally unused.

## Paid time

Shopify REST order payloads have no `paid_at`. The function sets `paid_at` from `processed_at` (then `updated_at`, then `created_at`) when the topic is `orders/paid` or `financial_status` is `paid`, `partially_paid`, or `partially_refunded`. A later event that does not include a paid time does not clear one that was already stored. The upsert key is `shopify_order_id`, so `orders/create` and `orders/paid` for the same order update one row.

Topics other than `orders/create`, `orders/paid`, and `customers/create` get `200` and are not stored, so Shopify does not retry them for 48 hours.

## Tests

```bash
deno test supabase/functions
```

Covers a valid HMAC, an invalid HMAC, a missing header, raw-body whitespace, exact email match, domain match, free-mail exclusion, exact free-mail match, and no match. The existing Express suite stays `npm test`.

## Go-live steps

Run these only after review and merge. Do not run them from a pull request check.

### 1. Set the function secret

Hosted Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into Edge Functions. Do not paste the service role key into the repo or into git.

Set the Shopify signing secret by name:

```bash
supabase secrets set SHOPIFY_WEBHOOK_SECRET=<webhook-signing-secret>
```

Use the secret that will sign the webhooks you register in step 4.

- Webhooks subscribed by the custom app are signed with that app's API secret key (the same value as `SHOPIFY_API_SECRET` on the Express app, if these webhooks belong to that app).
- Webhooks created under Shopify admin Settings → Notifications are signed with the signing secret shown on that page. That value is not necessarily `SHOPIFY_API_SECRET`.

### 2. Apply the migration

The migration expects `public.apify_local_business_leads` to already exist with columns `id`, `domain`, `emails`, and `company_domain_emails`. It fails at apply time if that table or those columns are missing. It does not modify the leads table.

Confirm `id` before or just after apply. If you want a foreign key, change `barber_lead_id` from `text` to that type and add the constraint in a follow-up migration. Do not guess the type in production from this file.

Link the project from a trusted machine (the project ref is not stored in this repo), then apply:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Or paste `supabase/migrations/20260924120000_shopify_order_customer_sync.sql` into the Supabase SQL editor and run it there. Running it twice is not safe: `create table` will fail if the tables already exist.

### 3. Deploy the function with JWT verification off

```bash
supabase functions deploy shopify-webhook --no-verify-jwt
```

`--no-verify-jwt` is required. The hosted gateway would otherwise reject Shopify, because Shopify does not send `Authorization: Bearer <supabase-jwt>`.

There is no `supabase/config.toml` in this repo on purpose, so a later deploy without the flag would turn JWT verification back on. Keep passing `--no-verify-jwt`.

The function URL will look like:

```text
https://<project-ref>.supabase.co/functions/v1/shopify-webhook
```

### 4. Register the three webhooks

Do this after the function is deployed. Registering them is what makes the sync live.

Shopify admin: Settings → Notifications → Webhooks → Create webhook. Format JSON. Same URL for all three topics:

- `Order creation` (`orders/create`)
- `Order payment` (`orders/paid`)
- `Customer creation` (`customers/create`)

Admin API (repeat for `orders/paid` and `customers/create`):

```bash
curl -X POST "https://<shop>.myshopify.com/admin/api/2024-07/webhooks.json" \
  -H "X-Shopify-Access-Token: <admin-access-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "topic": "orders/create",
      "address": "https://<project-ref>.supabase.co/functions/v1/shopify-webhook",
      "format": "json"
    }
  }'
```

Use a real shop domain, token, and project ref only on the machine where you run this. Do not commit them.

Then use "Send test notification" in the admin. A correct secret returns HTTP 200. A wrong secret returns 401. A successful `orders/create` test inserts or updates one `shopify_orders` row. These registrations are in addition to the existing Express routes (`/webhooks/orders/create`, `/webhooks/orders/paid`, `/webhooks/orders/fulfilled`). Delete an old webhook only if you intend to stop that path.

### 5. Confirm, then stop

Check one row in `shopify_orders` and, when the payload had a customer, `shopify_customers`. Confirm `barber_lead_id` only when the email or the company domain really belongs to that lead.

## Rollback

Unregistered webhooks stop delivery. Undeploy with `supabase functions delete shopify-webhook`. Dropping the new tables does not touch `apify_local_business_leads`:

```sql
drop function if exists public.upsert_shopify_order(jsonb);
drop function if exists public.upsert_shopify_customer(jsonb);
drop function if exists public.shopify_barber_lead_candidates(text, text);
drop table if exists public.shopify_orders;
drop table if exists public.shopify_customers;
```

## Assumptions

- `apify_local_business_leads.id` can be cast to text. `emails` and `company_domain_emails` are text, text arrays, or JSON arrays of addresses (or `{ "email": "..." }` objects). `domain` is text and may be a bare host or a URL.
- Domain match is exact after stripping `www.` and a scheme. `orders@shop.frisorsalong.se` does not match a lead whose domain is `frisorsalong.se`.
- The candidate SQL uses `strpos` and is a prefilter. The TypeScript matcher is the rule that decides. A lead list of tens of thousands of rows may need a more selective index later.
- `orders/fulfilled` stays on the Express app. This function does not run B2B pricing or the existing automation webhooks.
