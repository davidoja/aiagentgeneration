# Finance Gateway

Ekonomi-Erik får aldrig anropa Fortnox direkt. Edge-funktionen `finance-gateway` är den enda vägen. Fortnox-klient, access token och refresh token ligger bara på serversidan. Allowlist, ASK-konton, period, beloppsgräns, engångsgodkännande och nödstopp avgörs i funktionen. Ett anrop som inte står i allowlisten finns inte.

Inget i det här repot applicerar migrationen, deployar funktionen eller mergar. Gör stegen nedan först efter granskning och merge.

## Säkerhetsmodell

- Erik autentiserar med en egen bearer-token (`fg_…`). Den sparas bara som SHA-256. Admin-vägen visar klartexten en gång. En återkallad token slutar fungera.
- Fortnox `client_id` och `client_secret` är Supabase-hemligheter (`FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET`).
- Access token och refresh token ligger i `finance_oauth_tokens`. Tabellen har tvingad RLS, inga policies och inga grants till `anon` eller `authenticated`. Bara service role, via funktionen, läser och skriver den.
- Fortnox roterar refresh token vid varje refresh. Den gamla slutar gälla direkt. Funktionen sparar den nya innan API-anropet. Misslyckas sparningen görs inget bokföringsanrop. Se [Get Refresh-Token](https://www.fortnox.se/developer/authorization/get-refresh-token) och [Authorization](https://www.fortnox.se/developer/authorization): ny refresh token skapas, den gamla blir ogiltig, livslängd 45 dagar, access token 1 timme.
- Admin-vägen kräver `FINANCE_ADMIN_TOKEN`. Agent-token kan inte ändra policy, godkännanden, nödstopp eller OAuth.
- Svar och audit-loggen kapas på fält som heter token, secret, password, authorization eller refresh. Loggraden innehåller agent, metod, path, payload-hash, resultat, reason, source och decision. Ingen råbody och ingen hemlighet.
- `finance_audit_log` är append-only (ingen update/delete-grant, trigger som avvisar ändring och truncate).
- Nödstoppet är påslaget i migrationen. Saknas policyrad, går inte policy att läsa, eller är spärrkontolistan tom, vägras skrivningar. Det är fail closed.

## Anrop

`POST /functions/v1/finance-gateway`

```http
Authorization: Bearer fg_…
Content-Type: application/json
```

```json
{
  "method": "POST",
  "path": "/3/vouchers",
  "query": {},
  "body": {},
  "category": "routine",
  "transactionDate": "2026-09-01",
  "dryRun": false,
  "approvalId": null
}
```

Deploya med JWT-verifiering av. Erik skickar inte en Supabase-JWT. `supabase/config.toml` sätter `verify_jwt = false` för den här funktionen. Skicka ändå `--no-verify-jwt` vid deploy, samma mönster som övriga funktioner i repot.

### Skrivningar

| Metod | Fortnox-path | Kategori |
| --- | --- | --- |
| POST | `/3/vouchers` | `routine`, `reclassification`, `accrual`, `write_down` |
| POST | `/3/invoicepayments` | `payment` |
| PUT | `/3/invoicepayments/{id}/bookkeep` | `payment` |
| POST | `/3/supplierinvoicepayments` | `payment` |
| PUT | `/3/supplierinvoicepayments/{id}/bookkeep` | `payment` |
| POST | `/3/voucherfileconnections` | `file` |
| POST | `/3/supplierinvoicefileconnections` | `file` |
| POST | `/3/archive` | `archive` |

Arkivuppladdning skickas som JSON, inte multipart, till gatewayen. Funktionen bygger multipart mot Fortnox.

```json
{
  "method": "POST",
  "path": "/3/archive",
  "category": "archive",
  "body": {
    "fileName": "kvitto.pdf",
    "contentType": "application/pdf",
    "contentBase64": "cGxhY2Vob2xkZXI="
  }
}
```

Max 8 MB avkodat. `fileName` är `A–Z`, `a–z`, `0–9`, punkt, understreck, bindestreck.

### Läsningar (bara GET)

Verifikationer, verifikationsserier, kundfakturor, leverantörsfakturor, kundinbetalningar, leverantörsbetalningar, konton, räkenskapsår, kunder, leverantörer, inbox, arkiv, kopplade filer och företagsinformation.

Exempel: `GET /3/vouchers`, `GET /3/vouchers/A/12`, `GET /3/vouchers/sublist/A`, `GET /3/invoices/204`, `GET /3/supplierinvoices`, `GET /3/invoicepayments`, `GET /3/supplierinvoicepayments`, `GET /3/accounts/1930`, `GET /3/financialyears`, `GET /3/customers/1`, `GET /3/suppliers/9`, `GET /3/inbox`, `GET /3/archive`, `GET /3/companyinformation`.

Query-nycklar som släpps igenom: `lastmodified`, `financialyear`, `financialyeardate`, `fromdate`, `todate`, `page`, `limit`, `offset`, `sortby`, `sortorder`, `filter`, `customernumber`, `suppliernumber`, `accountnumber`. Se [Fortnox parameters](https://www.fortnox.se/developer/guides-and-good-to-know/parameters).

Path och verb följer [Fortnox API v3](https://api.fortnox.se/apidocs). Bookkeep är PUT. Filkoppling och arkiv är POST.

### Finns inte

- Alla DELETE, inklusive borttag av bokförd leverantörsbetalning.
- Inställningar: `/3/settings/company`, `/3/modesofpayments`, `/3/predefinedaccounts`, kontoplan och kontoskapande.
- Bankbetalning och betalningsinitiering: path som innehåller `bank`, `paymentorder`, `directdebit`, `noxfinans` eller `approvalpayment` (godkännande av betalning på leverantörsfaktura).
- PUT som uppdaterar en betalning på plats. Bara `…/bookkeep` är en tillåten PUT.
- Skapa eller ändra fakturor, leverantörsfakturor, kunder, leverantörer eller räkenskapsår.
- OAuth-endpointen. Erik kan inte läsa eller rotera Fortnox-token.

## Kategori och beloppsgräns

Varje skrivning måste ha `category`. Servern släpper bara den kategori som pathen tillåter.

| Kategori | Betydelse | Beloppsgräns |
| --- | --- | --- |
| `routine` | Vanlig verifikation: intäkt, kostnad, omföring inom den löpande bokföringen | Nej |
| `reclassification` | Ombokning | Ja |
| `accrual` | Periodisering | Ja |
| `write_down` | Nedskrivning | Ja |
| `payment` | Skapa eller bokför kund- eller leverantörsbetalning | Nej |
| `file` | Koppla fil till verifikation eller leverantörsfaktura | Nej |
| `archive` | Ladda upp till arkivet | Nej |

Föreslagen gräns, tills David bekräftar den: **10 000 SEK per rad**. En rad över gränsen i `reclassification`, `accrual` eller `write_down` kräver engångsgodkännande. 10 000 exakt passerar. Beloppet är absolutvärdet av debet, kredit eller `Amount` på raden. Valuta måste vara SEK om fältet finns.

ASK-konton stoppas oavsett kategori. Det täcker eget kapital, skattekontot, moms, personalskatt och personalkostnader. En stor ombokning mellan två vanliga konton (till exempel 1930 och 2440) som Erik märker `routine` träffar inte beloppsgränsen. Det är ett medvetet val så att den löpande bokföringen kan gå utan godkännande. Vill David att även `routine` över ett belopp ska stoppas ändras regeln i en senare migration.

## ASK-konton

Skrivning som nämner något av dessa konton vägras utan giltigt engångsgodkännande av typen `ask_account`:

- 2010–2099 eget kapital
- 2393
- 2510–2519 skatteskulder
- 2710–2799 personalens skatter och avgifter
- 2890, 2893, 2898
- 1480, 1630 skattekontot, 1650 momsfordran, 2650 momsredovisning
- 7000–7699 personalkostnader
- 8910–8999 bokslutsdispositioner och skatt

Listan ligger i `finance_blocked_accounts` och i `blocked_accounts.ts`. Ett test läser migrationen och kräver att samma intervall finns på båda ställena. Godkännande häver inte periodregeln.

## Period

För verifikation och båda betalningstyperna krävs `transactionDate` (`YYYY-MM-DD`). Datumet i Fortnox-bodyn (`TransactionDate` eller `PaymentDate`) måste vara samma. Vid `…/bookkeep` räcker kuvertets datum, eftersom Fortnox-anropet ofta saknar body.

Datumet måste ligga i det räkenskapsår som står i `finance_policy`, tidigast den 1:a i föregående kalendermånad, och aldrig i framtiden. Dagen räknas i `Europe/Stockholm`. Räkenskapsåret är tomt i migrationen. Skrivningar vägras tills David sätter start och slut. Ett godkännande kan inte flytta datumet.

## Engångsgodkännande

Admin skapar ett godkännande per konkret post. Det är bundet till en agent, har `expiresAt`, och förbrukas en gång när skrivningen släpps igenom (inte vid dry-run). Förbrukningen är atomär (`finance_consume_approvals`). Två parallella anrop kan inte använda samma rad.

- `ask_account`: `accounts` måste innehålla varje spärrat konto i anropet.
- `amount_threshold`: `category` och `maxAmountSek` måste täcka raden. `maxAmountSek` är taket för just den posten, inte en ny stående gräns.
- Sätt `payloadHash` när posten ska vara exakt den bodyn. Hashen är SHA-256 hex av kanoniskt JSON (nycklar sorterade rekursivt, arrayordning bevarad) av Fortnox-bodyn. `POST /admin/payload-hash` med admin-token räknar den. Funktionen loggar inte bodyn.

Kuvertet kan skicka `approvalId` eller `approvalIds` (högst två, ett per behov).

## Nödstopp

`finance_policy.global_kill_switch` gäller alla agenter. `finance_agents.kill_switch` gäller en agent. Påslaget stopp läser och skrivningar. Admin-vägen fungerar fortfarande, annars går det inte att slå av stoppet. Oläsbar policy behandlas som stopp.

## Dry-run

`"dryRun": true` kör samma regler och skriver audit med decision `dry_run`. Inget Fortnox-anrop, ingen token-refresh, inget godkännande förbrukas.

## Admin

`Authorization: Bearer <FINANCE_ADMIN_TOKEN>`

| Metod och path | Verkan |
| --- | --- |
| POST `/admin/agents` | `{ "name": "Ekonomi-Erik" }` skapar agent och returnerar token en gång |
| POST `/admin/agents/{id}/revoke` | Återkallar token |
| POST `/admin/agents/{id}/kill-switch` | `{ "engaged": true, "reason": "…" }` |
| POST `/admin/kill-switch` | Globalt nödstopp |
| POST `/admin/policy` | `{ "amountThresholdSek": 10000, "financialYearStart": "2026-01-01", "financialYearEnd": "2026-12-31" }` |
| POST `/admin/approvals` | Skapar engångsgodkännande |
| POST `/admin/oauth/refresh-token` | `{ "refreshToken": "…" }` sparar token. Svaret innehåller den inte |
| POST `/admin/payload-hash` | `{ "body": { } }` returnerar hash |
| GET `/admin/audit?limit=50` | Senaste raderna, utan hemligheter |

Bas-URL: `https://<project-ref>.supabase.co/functions/v1/finance-gateway`.

## Vad David gör

1. Bekräfta beloppsgränsen 10 000 SEK per rad för ombokning, periodisering och nedskrivning, eller säg ett annat tal.
2. I Fortnox Developer Portal: rotera client secret för integrationen. Kopiera inte secret till git, Slack eller den delade Linux-burken.
3. Sätt om redirect-URI och scopes vid om-auktorisering. Be bara om de scopes gatewayen använder: `bookkeeping`, `invoice`, `supplierinvoice`, `payment`, `customer`, `supplier`, `inbox`, `archive`, `connectfile`, `companyinformation`. Ta inte med `settings`. Scopes: [Fortnox scopes](https://www.fortnox.se/developer/guides-and-good-to-know/scopes).
4. Auktorisera appen på nytt (`access_type=offline` så att en refresh token utfärdas). Byt koden mot token enligt [Get Access-Token](https://www.fortnox.se/developer/authorization/get-access-token). Gör det från en betrodd maskin, inte från Eriks runtime.

```bash
curl -s -X POST https://apps.fortnox.se/oauth-v1/token \
  -H "Authorization: Basic <base64 av client_id:client_secret>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<kod>&redirect_uri=<samma redirect-URI som i portalen>"
```

5. Lämna refresh token till admin-vägen när Mattias har deployat. Spara den inte i repot.

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/oauth/refresh-token" \
  -H "Authorization: Bearer <FINANCE_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refresh-token från steget ovan>"}'
```

6. Skapa Eriks agent och ge honom token en gång:

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/agents" \
  -H "Authorization: Bearer <FINANCE_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ekonomi-Erik"}'
```

7. Sätt räkenskapsår och, om ni ändrar förslaget, beloppsgränsen via `POST /admin/policy`.
8. Slå av det globala nödstoppet först när checklistan nedan är grön:

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/kill-switch" \
  -H "Authorization: Bearer <FINANCE_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"engaged":false,"reason":"go-live"}'
```

9. Ta bort Fortnox-credentials från den delade Linux-burken när gatewayen har tagit ett lyckat anrop.

## Vad Minnes-Mattias gör

1. Merga inte förrän PR:en är granskad. Applicera inte migrationen mot någon hostad Supabase från en feature-branch.
2. Efter merge, på rätt projekt:

```bash
supabase db push
```

eller kör `supabase/migrations/20260924210000_finance_gateway.sql` i SQL-editorn. Migrationen rör inte Shopify-tabellerna.

3. Verifiera RLS och grants:

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'finance_%';
```

`relrowsecurity` och `relforcerowsecurity` ska vara true. `anon` och `authenticated` ska sakna grants. `finance_audit_log` ska bara ha select och insert för `service_role`.

4. Sätt hemligheter. Värdena hör hemma här, inte i git:

```bash
supabase secrets set \
  FORTNOX_CLIENT_ID=replace-with-fortnox-client-id \
  FORTNOX_CLIENT_SECRET=replace-with-fortnox-client-secret \
  FINANCE_ADMIN_TOKEN=replace-with-long-random-admin-token
```

`FINANCE_ADMIN_TOKEN` kan skapas med `openssl rand -base64 32`. Lägg den inte i Eriks miljö.

5. Deploya:

```bash
supabase functions deploy finance-gateway --no-verify-jwt
```

6. Kontrollera att en GET utan bearer ger 401, att DELETE mot en betalning ger `delete_forbidden`, och att en verifikation i dry-run inte syns i Fortnox.
7. Håll access token och refresh token i `finance_oauth_tokens`. Lägg dem inte i funktionsloggar, i en `.env` på burken, eller i en annan tabell med policy för `authenticated`.

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` finns redan i Edge Functions-miljön.

## Go-live-checklista

- [ ] PR mergad av en människa. Migrationen är inte körd före det.
- [ ] RLS forced och grants verifierade.
- [ ] Client secret roterad i Fortnox. Gamla secret är död.
- [ ] Appen om-auktoriserad utan `settings`.
- [ ] Refresh token sparad via admin-vägen. Svaret innehöll den inte.
- [ ] Eriks agent-token utfärdad och lagrad bara hos Erik. Hash i `finance_agents`.
- [ ] Räkenskapsår satt. Beloppsgränsen 10 000 SEK bekräftad eller ändrad.
- [ ] Dry-run av en vanlig verifikation ger `dry_run` och inget Fortnox-anrop.
- [ ] Ett anrop mot ett ASK-konto utan godkännande ger `ask_account`.
- [ ] DELETE och `/3/settings/company` vägras.
- [ ] Nödstoppet slås av av David.
- [ ] Credentials borta från den delade Linux-burken.

## Fortnox-händelser

Fortnox har en WebSocket för händelser: [Websockets](https://www.fortnox.se/developer/guides-and-good-to-know/websockets), `wss://ws.fortnox.se/topics-v1`.

Relevanta topics för uppföljning är bland andra `invoices` (inklusive `invoicepayment-bookkeep-v1`), `supplier-invoices`, `vouchers`, `customers`, `suppliers` och `financial-years`. Händelsen säger vad som hänt och vilket id, inte hela dokumentet. Klienten ska därefter hämta entiteten. Leverans är at-least-once. Offset kan spelas upp 14 dagar.

Anslutningen autentiseras med `clientSecret` och access tokens i kommandot `add-tenants-v1`. Den hemligheten får inte ligga hos Erik. En edge function är request/response och håller inte en lång socket. Den här PR:en öppnar därför ingen WebSocket.

Tills en serverside-prenumerant finns bakom samma policy: polla genom gatewayens GET-allowlist.

- Verifikationer, kundfakturor, leverantörsfakturor och båda betalningstyperna: var 15:e minut kl. 07–19 `Europe/Stockholm`, annars en gång i timmen.
- Inbox och arkiv: var 30:e minut under tiden Erik kopplar underlag.
- Konton, räkenskapsår, kunder, leverantörer och företagsinformation: en gång per dygn.
- Använd `lastmodified` där Fortnox stödjer det, och backa av vid HTTP 429.

Webhooks i Fortnox täcker inte bokföringsytan. De som finns är smalare (till exempel bankorder och livscykel för integrationen) och ersätter inte pollningen ovan.

## Tester

```bash
deno test --allow-read=supabase/migrations supabase/functions/finance-gateway
```

Testerna mockar Fortnox. De täcker allowlist, DELETE, inställningar, ASK-konto, engångs- och utgånget godkännande, period, beloppsgräns, nödstopp, felaktig agent-token, dry-run utan anrop, och att en roterad refresh token sparas och inte läcker i svaret.

## Driftstatus

Funktionen är inte deployad. Migrationen är inte applicerad. Inga riktiga kundnummer, organisationsnummer eller Fortnox-uppgifter finns i repot.
