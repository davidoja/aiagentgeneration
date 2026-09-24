# Shopify to Supabase sync

Sultan AB Shopify orders and customers land in Supabase and link to the existing barber, organization, and contact records. A second function accepts the public wholesale form. The Express app, checkout, and the Avada minimum order (EUR 148) are unchanged.

Nothing in this repository applies the migrations, deploys a function, or registers a Shopify webhook. Run the go-live steps below only after this change is reviewed and merged.

## What is stored

`public.shopify_orders` (primary key `shopify_order_id`, so a retry updates the same row):

- order number and Shopify order name
- Shopify created time and paid time
- financial status, currency, total, subtotal, tax, discounts
- customer email, customer name, company name
- shipping and billing country
- line items as JSON
- optional raw webhook JSON
- `contact_id`, `barber_id`, and `organization_id` (uuid foreign keys, `on delete set null`)
- nullable `barber_lead_id` (text copy of an Apify lead id when that lead's email matches)

`public.shopify_customers` holds `customers/create` and `customers/update`, and the customer embedded on an order. It has the same uuid foreign keys.

`raw_payload` is kept so a mapping fix can be replayed from a webhook Shopify will not send again. The column holds names, email, and addresses. Integers of 16 or more digits are stored as JSON strings so JavaScript does not round Shopify ids.

This migration does not create or alter `barbers`, `organizations`, `contacts`, `outreach_sends`, `outreach_events`, `wholesale_applications`, or `apify_local_business_leads`, except for one partial unique index on `outreach_events` and a column-compatible replacement of `v_outreach_perf_30d`. Row level security on those existing tables is left as it is (enabled, not forced).

## Security model

- Shopify signs the raw body with HMAC-SHA256 (`X-Shopify-Hmac-Sha256`). The function compares the MAC bytes in constant time. A missing or invalid signature returns 401 and does not read or write the database.
- Deploy both functions with JWT verification **disabled**. Shopify and the storefront browser cannot send a Supabase JWT. There is no `supabase/config.toml` in this repo, so a later deploy without `--no-verify-jwt` would turn JWT verification back on. Keep passing the flag.
- With JWT verification off, the webhook URL is reachable without a Supabase key. The HMAC secret is the authentication check. The wholesale URL is reachable from a browser; CORS is not authentication.
- Row level security is enabled and forced on `shopify_orders` and `shopify_customers` only. There are no policies. `anon` and `authenticated` have no grants. The functions use `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.
- Logs include the topic, Shopify ids, and whether a row matched. They do not include the body, email, name, or address.
- Secrets are environment variables. This repo does not contain a service role key, webhook secret, or customer data.

## Matching

The edge function calls `match_shopify_party`. The same order is implemented in `supabase/functions/_shared/match.ts` for tests. It does not load the organization table into the function.

1. Exact email, case-insensitive, on `contacts.email` and `barbers.email`. A unique Apify lead whose `emails` or `company_domain_emails` text contains that exact address is stored in `barber_lead_id`. It does not override the barber or organization chosen here.
2. Otherwise the email domain, passed through the existing `normalize_domain()`, against `organizations.website_url` and `organization_identifiers` where `identifier_type = 'domain'`. Free-mail domains are skipped. If that organization has exactly one barber, `barber_id` is set.
3. Otherwise company name plus country, and only when that pair hits exactly one barber (`barbers.name` + `barbers.country`) or exactly one organization (`display_name` or `legal_name`, plus `locations.country_code`). A barber and an organization that point at different organizations are left unmatched.

If more than one barber shares the email, the row is not linked to a barber or organization and step 2 is not used. A single contact can still be returned.

Free-mail means the first DNS label is `gmail`, `googlemail`, `gmx`, `outlook`, `hotmail`, `yahoo`, `icloud`, or `t-online`, plus the exact domains `web.de`, `me.com`, and `mac.com`. `live.com`, `msn.com`, `aol.com`, and `proton.me` are not excluded. An exact free-mail address can still match step 1.

Domain match is exact after `normalize_domain`. `orders@shop.frisorsalong.se` does not match `frisorsalong.se`. Country values are compared as stored (uppercased). `Sweden` does not become `SE`.

Every Shopify email is passed to the existing `upsert_contact` (`consent_status` `unknown`, `source_key` `shopify`, tag `shopify_customer`). That function updates the contact with the same email instead of inserting a second row. `unknown` does not downgrade an existing consent status.

## Outreach conversion

`outreach_sends` identifies the recipient by `recipient_email`. When an order email matches a send with `sent_at` in the last 90 days, `record_shopify_outreach_conversion` inserts one `outreach_events` row:

- `event_type` `converted_order`
- `source_system` `shopify`
- `external_id` the Shopify order id
- `metadata` `shopify_order_id`, `amount`, and `currency` only

The event is attached to the latest matching send. A partial unique index on `external_id` where `event_type = 'converted_order'` makes a repeated delivery of the same order a no-op. Other event types are not constrained.

When that send exists, the matched barber is set to `status = 'customer'` and the matched organization to `lifecycle_status = 'customer'`, unless the row is already `customer` or `partner`. `partner` is left as `partner`.

`v_outreach_perf_30d` keeps `security_invoker = on` and every existing column, in the same order, with the same `score_30d` formula. `conversions`, `weighted_conversions`, and `conversion_rate` are appended. The view still only includes sends from the last 30 days, so a conversion on an older send (still inside 90 days) is stored on `outreach_events` and does not appear in this view.

## Topics

Handled, as idempotent upserts: `orders/create`, `orders/paid`, `orders/updated`, `customers/create`, `customers/update`.

Any other topic returns 200 and is not stored, so Shopify does not retry it for 48 hours.

## Paid time

Shopify REST order payloads have no `paid_at`. The function sets `paid_at` from `processed_at` (then `updated_at`, then `created_at`) when the topic is `orders/paid` or `financial_status` is `paid`, `partially_paid`, or `partially_refunded`. A later event that does not include a paid time does not clear one that was already stored. A later payload that omits a match id does not clear `contact_id`, `barber_id`, `organization_id`, or `barber_lead_id`.

## Wholesale form

`supabase/functions/wholesale-inquiry` accepts JSON from the live DistributorForm. It checks the required fields and the email, ignores a filled honeypot (`company_website`, added by the snippet, not by the theme), and allows 5 posts per IP per 10 minutes inside one function instance. CORS allows only `https://brandsofsultan.com`.

A valid post inserts `public.wholesale_applications`. The existing `wholesale_applications_sync_canonical` trigger runs on that insert. The function then calls `upsert_contact` (`consent_status` `legitimate_interest`, `source_key` `shopify_wholesale`, tag `wholesale_lead`). Field names are the live `contact[...]` names: `Company`, `name`, `email`, `phone`, `Country or market`, `VAT or company number`, `Website`, `Business type`, `Outlets supplied`, `Brands carried`, `body`, `Inquiry type`, `Submitted from`. Business type is stored as submitted (`Grossist`, `Wholesaler`, `Großhändler`, and the other localized options).

The theme is not edited in this repo. After deploy, copy `theme-snippets/distributor-form-supabase.js` to the theme asset `assets/distributor-form-supabase.js`. In `sections/sultan-distributor-form.liquid`, after `{%- endform -%}` and before `{% schema %}`, add:

```liquid
<script src="{{ 'distributor-form-supabase.js' | asset_url }}"></script>
```

Do not add `defer`. The form element has to exist when the snippet runs. Do not change the form fields, and do not stop the submit. The snippet posts with `fetch(keepalive)` and then the Shopify contact form still submits, so the email to the store address still goes out.

The snippet only listens to `#DistributorForm`. It does not run on checkout.

## Tests

```bash
deno test supabase/functions
npm test
```

Deno covers HMAC (valid, invalid, missing, raw body), Apify email and domain matching, canonical email / domain / company matching, free-mail exclusion, outreach conversion idempotency, `orders/updated` and `customers/update`, and wholesale validation, honeypot, and CORS. `npm test` is the existing Express HMAC suite.

## Go-live steps

Run these in this order, only after review and merge. Do not run them from a pull request check.

### 1. Apply the migrations

Both files, in timestamp order:

- `supabase/migrations/20260924120000_shopify_order_customer_sync.sql`
- `supabase/migrations/20260924183000_shopify_canonical_match.sql`

The second file expects the existing CRM tables and `normalize_domain(text)`. It does not create them. The first file's `create table` is not safe to run twice. The second file uses `add column if not exists` and `create or replace`.

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Or paste each file into the Supabase SQL editor and run them in the order above.

### 2. Deploy both functions with JWT verification off

```bash
supabase functions deploy shopify-webhook --no-verify-jwt
supabase functions deploy wholesale-inquiry --no-verify-jwt
```

### 3. Set the webhook secret

Hosted Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into Edge Functions. Do not paste the service role key into the repo or into git.

`wholesale-inquiry` needs only those injected values. `shopify-webhook` also needs:

```bash
supabase secrets set SHOPIFY_WEBHOOK_SECRET=<webhook-signing-secret>
```

Use the secret that will sign the webhooks you register in step 4.

- Webhooks subscribed by the custom app are signed with that app's API secret key (the same value as `SHOPIFY_API_SECRET` on the Express app, if these webhooks belong to that app).
- Webhooks created under Shopify admin Settings → Notifications are signed with the signing secret shown on that page. That value is not necessarily `SHOPIFY_API_SECRET`.

Until this secret is set, signed Shopify deliveries receive 500 and are not stored.

### 4. Register the webhooks

Do this after the secret is set. Registering them is what makes the sync live.

URL for all five topics:

```text
https://wsqxlbdujiqthnihfaww.supabase.co/functions/v1/shopify-webhook
```

Topics:

- `orders/create`
- `orders/paid`
- `orders/updated`
- `customers/create`
- `customers/update`

Shopify admin: Settings → Notifications → Webhooks → Create webhook. Format JSON.

Admin API (repeat for the other four topics):

```bash
curl -X POST "https://<shop>.myshopify.com/admin/api/2024-07/webhooks.json" \
  -H "X-Shopify-Access-Token: <admin-access-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "topic": "orders/create",
      "address": "https://wsqxlbdujiqthnihfaww.supabase.co/functions/v1/shopify-webhook",
      "format": "json"
    }
  }'
```

Use a real shop domain and token only on the machine where you run this. Do not commit them.

Then use "Send test notification" in the admin. A correct secret returns HTTP 200. A wrong secret returns 401. These registrations are in addition to the existing Express routes (`/webhooks/orders/create`, `/webhooks/orders/paid`, `/webhooks/orders/fulfilled`). Delete an old webhook only if you intend to stop that path.

### 5. Confirm, then add the theme snippet

Check one row in `shopify_orders` and, when the payload had a customer, `shopify_customers`. Confirm `barber_id` or `organization_id` only when the email, domain, or the single company-and-country hit really belongs to that record.

Copy the snippet as described under Wholesale form. Submit the distributor form once on `https://brandsofsultan.com` and confirm one `wholesale_applications` row and that the store email still arrives. Do not change checkout.

## Rollback

Unregister the five webhooks. Undeploy with `supabase functions delete shopify-webhook` and `supabase functions delete wholesale-inquiry`. Remove the theme script tag if it was added.

Do not drop `barbers`, `organizations`, `contacts`, `outreach_sends`, `outreach_events`, `wholesale_applications`, or `apify_local_business_leads`. Stopping the webhooks stops new Shopify writes. The `shopify_*` tables can stay.

## Assumptions

- `barber_lead_id` stays text. Canonical links are the uuid foreign keys. An Apify id is copied only when exactly one lead matches the email.
- Organization domains come from `website_url` (via `normalize_domain`) and from `organization_identifiers.identifier_type = 'domain'`. `barbers.domain` is not used for step 2. If the matched organization has exactly one barber, that barber is linked.
- Company plus country uses `barbers.name` and `barbers.country`, or `organizations.display_name` / `legal_name` plus `locations.country_code`. Both the name and the country must be present. The country string is not translated.
- Two barbers with the same email produce no barber and no organization, and the matcher does not continue to domain or company. A unique contact is still returned.
- Calling `upsert_contact` for a Shopify buyer creates a `contacts` row when that email is new. Retail buyers are included. Consent `unknown` does not downgrade a stronger status.
- A conversion is recorded only when `recipient_email` equals the order email and `sent_at` is inside 90 days. It hangs off the latest such send. `partner` is not overwritten with `customer`.
- `score_30d` is unchanged. Conversion columns count events on sends from the last 30 days only.
- Localized business-type labels are stored verbatim. The existing wholesale trigger maps an unknown business type onto the organization role it already uses.
- The wholesale rate limit is memory inside one isolate, not a global counter. A request that forges the `Origin` header is not stopped by CORS.
- The first migration is not idempotent. The second one is.
