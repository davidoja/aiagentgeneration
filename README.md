# Shopify Backend Service (Headless)

## 1) Föreslagen arkitektur
- **API-lager (Express/Node)**
  - Hanterar OAuth-installation, webhook endpoints och interna API-anrop.
- **Service-lager**
  - `shopifyClient` kapslar Shopify Admin API-anrop och retry-logik.
  - `orders` och `b2bPricing` kapslar affärslogik kring order och B2B-priser.
- **Workflows**
  - Automationsflöden som körs efter orderhändelser (taggar, notifiering, export).
- **Stateless + serverless**
  - All logik är stateless; tokens kan flyttas till extern lagring (t.ex. Redis/Supabase) för produktion.

## 2) Mappstruktur
```
src/
  config/
    env.js
  routes/
    auth.js
    orders.js
    webhooks.js
  services/
    b2bPricing.js
    orders.js
    shopifyClient.js
    tokenStore.js
  utils/
    crypto.js
    http.js
    shopifyAuth.js
  workflows/
    orderAutomation.js
  server.js
.env.example
package.json
```

## 3) Exempel som ingår (körbar kod)

### Shopify auth (OAuth)
- `GET /auth?shop=your-store.myshopify.com`
- `GET /auth/callback`

Implementerat i `src/routes/auth.js` och använder verifierad HMAC, state samt token-lagring.

### Webhook handler
- `POST /webhooks/orders/create`
- `POST /webhooks/orders/paid`
- `POST /webhooks/orders/fulfilled`

Implementerat i `src/routes/webhooks.js` med säker HMAC-verifiering av rå request body.

### Funktion som hämtar orderdata
- `GET /orders/:orderId?shop=your-store.myshopify.com`

Implementerat i `src/routes/orders.js` och `src/services/orders.js`.

### Exempel på custom affärsregel (B2B-pris)
- Om kunden har taggen `B2B` hämtas ett kundspecifikt rabattvärde från `pricing.b2b_discount_percent` metafield.
- Rabatt appliceras på orderns line items i `src/services/b2bPricing.js`.

## 4) Deploy på Vercel eller Cloudflare Workers

### Vercel (Node.js)
1. Lägg till repo i Vercel.
2. Sätt miljövariabler enligt `.env.example`.
3. Vercel kör `npm install` och `npm start`.
4. Peka Shopify webhook-URL:er till `https://<your-vercel-app>/webhooks/...`.

### Cloudflare Workers (via Node adapter)
1. Flytta logik till en Worker-kompatibel router (t.ex. Hono/itty-router).
2. Använd `fetch` (redan kompatibelt) och konfigurera `wrangler.toml` för secrets.
3. Exponera endpoints och registrera webhook-URL:er i Shopify.

> För produktion: byt `tokenStore` till en extern databas/kv-store för att överleva cold starts.

## 5) Shopify → Supabase order/customer sync

Edge functions `shopify-webhook` and `wholesale-inquiry`, plus tables `public.shopify_orders` and `public.shopify_customers`. The webhook verifies the Shopify HMAC, upserts orders and customers, and links them to `barbers`, `organizations`, and `contacts`. The wholesale function accepts the distributor form. Checkout is unchanged.

This is not deployed. Apply the migrations, deploy both functions with `--no-verify-jwt`, set the webhook secret, then register the webhooks. See [docs/shopify-supabase-sync.md](docs/shopify-supabase-sync.md).

```bash
deno test supabase/functions
```
