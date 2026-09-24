# Finance Gateway

Ekonomi-Erik får aldrig anropa Fortnox direkt. Edge-funktionen `finance-gateway` är den enda vägen. Fortnox-klient, tenant id och access token ligger bara på serversidan. Allowlist, ASK-konton, period, beloppsgräns, engångsgodkännande och nödstopp avgörs i funktionen. Ett anrop som inte står i allowlisten finns inte.

Inget i det här repot applicerar migrationen, deployar funktionen eller mergar. Gör stegen nedan först efter granskning och merge.

## Säkerhetsmodell

- Erik autentiserar med en egen bearer-token (`fg_…`). Den sparas bara som SHA-256. Admin-vägen visar klartexten en gång. En återkallad token slutar fungera.
- Standardvägen är client credentials. Supabase-hemligheterna är `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` och `FORTNOX_TENANT_ID`. När tenant id är satt hämtar funktionen själv en kortlivad access token. David öppnar ingen consent-länk och kör inget skript.
- Anropet är `POST https://apps.fortnox.se/oauth-v1/token` med `Content-Type: application/x-www-form-urlencoded`, `Authorization: Basic` (base64 av `client_id:client_secret`) och headern `TenantId` med det numeriska tenant-id:t. Bodyn är `grant_type=client_credentials`. Scope utelämnas, så Fortnox använder scopes från service-kontots samtycke. Svaret innehåller `access_token`, `expires_in` (3600), `token_type` och `scope`. Det innehåller ingen refresh token. [Get Access-Token using Client-Credentials](https://www.fortnox.se/developer/authorization/get-access-token-using-client-credentials).
- Access token cachas i `finance_oauth_tokens` med `token_kind = client_credentials` och `refresh_token` null. En ny token hämtas när det är 60 sekunder eller mindre kvar. Token skrivs inte till loggen och skickas inte i svaret till Erik. Tabellen har tvingad RLS, inga policies och inga grants till `anon` eller `authenticated`.
- Om `FORTNOX_TENANT_ID` är tom används reservvägen med authorization code och refresh token. Fortnox roterar då refresh token vid varje refresh, och funktionen sparar den nya innan API-anropet. Misslyckas sparningen görs inget bokföringsanrop. Se [Get Refresh-Token](https://www.fortnox.se/developer/authorization/get-refresh-token). Det är inte standardvägen.
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
| POST `/admin/oauth/exchange-code` | Reservväg utan `FORTNOX_TENANT_ID`. `{ "code": "…" }` eller en redirect-URL. Svaret är `scopes`, aldrig token |
| POST `/admin/oauth/refresh-token` | Reservväg om en refresh token redan finns. Svaret innehåller inte token |
| POST `/admin/payload-hash` | `{ "body": { } }` returnerar hash |
| GET `/admin/audit?limit=50` | Senaste raderna, utan hemligheter |

Bas-URL: `https://<project-ref>.supabase.co/functions/v1/finance-gateway`.

## Vad David gör

Inget i standardvägen. När `FORTNOX_TENANT_ID` är satt hämtar gatewayen access token själv. David roterar inte client secret, öppnar ingen consent-länk och kör inte `golive.sh`.

## Vad Minnes-Mattias gör

Mattias applicerar migrationerna, sätter hemlighetsnamnen, deployar funktionen, kör SQL-bootstrap och kontrollerar RLS. Värdena ska inte in i git, Slack eller en delad burk.

1. Merga inte förrän PR:en är granskad. Applicera inte migrationerna mot någon hostad Supabase från en feature-branch.
2. Efter merge, på rätt projekt, applicera båda filerna i ordning:

```bash
supabase db push
```

eller kör först `supabase/migrations/20260924210000_finance_gateway.sql` och sedan `supabase/migrations/20260924223000_finance_oauth_client_credentials.sql` i SQL-editorn. Migrationerna rör inte Shopify-tabellerna. Nödstoppet förblir påslaget. Audit-loggen förblir append-only.

3. Lägg de här namnen under Edge Function secrets. Värdena kommer från den befintliga Fortnox-integrationen, inte från en ny consent:

- `FORTNOX_CLIENT_ID`
- `FORTNOX_CLIENT_SECRET`
- `FORTNOX_TENANT_ID`

`FORTNOX_TENANT_ID` är det numeriska tenant-id:t (samma värde som `DatabaseNumber`). `FINANCE_ADMIN_TOKEN` behövs inte för SQL-bootstrap. Sätt den bara om admin-vägarna anropas med curl. Lämna `FORTNOX_REDIRECT_URI` och `FORTNOX_OAUTH_STATE` tomma i standardvägen.

4. Verifiera RLS och grants:

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'finance_%';
```

`relrowsecurity` och `relforcerowsecurity` ska vara true. `anon` och `authenticated` ska sakna grants. `finance_audit_log` ska bara ha select och insert för `service_role`.

5. Deploya:

```bash
supabase functions deploy finance-gateway --no-verify-jwt
```

6. Bootstrap utan skript för David. Kör `supabase/functions/finance-gateway/bootstrap.sql` som service role i SQL-editorn, efter att hash-platsen bytts ut. På operatörens egen maskin:

```bash
TOKEN=$(openssl rand -hex 32)
printf 'fg_%s\n' "$TOKEN"
printf '%s' "fg_${TOKEN}" | sha256sum | awk '{print $1}'
unset TOKEN
```

Den första raden är Eriks token. Ge den till Erik en gång. Klistra bara in de 64 hextecknen i `bootstrap.sql`. Filen sätter räkenskapsår `2026-01-01` till `2026-12-31`, beloppsgräns 10 000 SEK och lämnar nödstoppet på. Inserten avvisas tills hashen är 64 hextecken.

7. När checklistan är grön, slå av nödstoppet i SQL-editorn:

```sql
update public.finance_policy
set global_kill_switch = false,
    kill_switch_reason = 'Go-live',
    updated_at = now()
where id = 1;
```

Slå på det igen med `global_kill_switch = true`.

Samma bootstrap finns som curl om `FINANCE_ADMIN_TOKEN` är satt. Det är valfritt. SQL-vägen ovan är standard.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $FINANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountThresholdSek":10000,"financialYearStart":"2026-01-01","financialYearEnd":"2026-12-31"}' \
  "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/policy"

curl -sS -X POST \
  -H "Authorization: Bearer $FINANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ekonomi-Erik"}' \
  "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/agents"

curl -sS -X POST \
  -H "Authorization: Bearer $FINANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"engaged":false,"reason":"go-live"}' \
  "https://<project-ref>.supabase.co/functions/v1/finance-gateway/admin/kill-switch"
```

`create-agent`-svaret visar Eriks token en gång. Spara den inte i git.

8. Kontrollera att en GET utan bearer ger 401, att DELETE mot en betalning ger `delete_forbidden`, och att en verifikation i dry-run inte syns i Fortnox.
9. Access token ska bara finnas i `finance_oauth_tokens` efter att Erik har gjort ett anrop. I client-credentials-läge är `refresh_token` null och `token_kind` är `client_credentials`. Lägg inte token i funktionsloggar eller i en `.env` i repot.

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` finns redan i Edge Functions-miljön.

## Reservväg utan tenant id

Om `FORTNOX_TENANT_ID` lämnas tom använder funktionen den tidigare refresh-token-vägen. Den kräver authorization code en gång, via `POST /admin/oauth/exchange-code` eller `golive.sh`. Använd den inte när tenant id finns. Admin-vägarna finns kvar för det fallet.

## Go-live-checklista

- [ ] PR mergad av en människa. Migrationerna är inte körda före det.
- [ ] Båda migrationerna applicerade. RLS forced och grants verifierade.
- [ ] `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` och `FORTNOX_TENANT_ID` satta som Edge Function-hemligheter. Inga värden i git.
- [ ] `bootstrap.sql` körd: Eriks hash i `finance_agents`, räkenskapsår 2026-01-01 till 2026-12-31, beloppsgräns 10 000 SEK. Klartext-token bara hos Erik.
- [ ] Dry-run av en vanlig verifikation ger `dry_run` och inget Fortnox-anrop.
- [ ] Ett anrop mot ett ASK-konto utan godkännande ger `ask_account`.
- [ ] DELETE och `/3/settings/company` vägras.
- [ ] Nödstoppet slås av i SQL efter punkterna ovan.
- [ ] Ett lyckat anrop cachar access token med `token_kind = client_credentials` och `refresh_token` null. Token syns inte i svaret eller loggen.

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

Testerna mockar Fortnox. De täcker allowlist, DELETE, inställningar, ASK-konto, engångs- och utgånget godkännande, period, beloppsgräns, nödstopp, felaktig agent-token, dry-run utan anrop, att en roterad refresh token sparas, att `exchange-code` tar en kod eller en redirect-URL, och att client credentials skickar `TenantId` plus `grant_type=client_credentials`, cachar access token utan refresh token och inte returnerar token.

## Driftstatus

Funktionen är inte deployad. Migrationerna är inte applicerade. Inga riktiga kundnummer, organisationsnummer eller Fortnox-uppgifter finns i repot.
