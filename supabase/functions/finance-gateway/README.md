# Finance Gateway

Ekonomi-Erik får aldrig anropa Fortnox direkt. Edge-funktionen `finance-gateway` är den enda vägen. Fortnox-klient, access token och refresh token ligger bara på serversidan. Allowlist, ASK-konton, period, beloppsgräns, engångsgodkännande och nödstopp avgörs i funktionen. Ett anrop som inte står i allowlisten finns inte.

Inget i det här repot applicerar migrationen, deployar funktionen eller mergar. Gör stegen nedan först efter granskning och merge.

## Säkerhetsmodell

- Erik autentiserar med en egen bearer-token (`fg_…`). Den sparas bara som SHA-256. Admin-vägen visar klartexten en gång. En återkallad token slutar fungera.
- Fortnox `client_id` och `client_secret` är Supabase-hemligheter (`FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET`). David klistrar in dem i Supabase-dashboarden. De ska inte ligga på en delad dator och inte skickas med curl till Fortnox.
- Första kopplingen är `POST /admin/oauth/exchange-code`. Funktionen byter själv koden hos Fortnox och sparar access token och refresh token. Svaret innehåller bara scopes.
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
| POST `/admin/oauth/exchange-code` | `{ "code": "…" }` eller `{ "redirectUrl": "https://localhost/fortnox-callback?code=…&state=…" }`. Funktionen byter koden hos Fortnox. Svaret är `scopes`, aldrig token |
| POST `/admin/oauth/refresh-token` | Reservväg om en refresh token redan finns. Inte Davids go-live-väg. Svaret innehåller inte token |
| POST `/admin/payload-hash` | `{ "body": { } }` returnerar hash |
| GET `/admin/audit?limit=50` | Senaste raderna, utan hemligheter |

Bas-URL: `https://<project-ref>.supabase.co/functions/v1/finance-gateway`.

## Vad David gör

Gör detta på din egen Mac, efter att Mattias har deployat funktionen. Client secret och admin-token klistras bara in i Supabase. De ska inte till Slack, git, den delade Linux-burken, eller en curl mot Fortnox.

1. I Supabase-dashboarden, under Edge Function secrets, lägg in `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` och `FINANCE_ADMIN_TOKEN`. Admin-token kan du skapa med en lösenordsgenerator (lång slumptext).
2. Spara admin-token i din lösenordshanterare. Den behövs varje gång du kör skriptet nedan.
3. I Fortnox Developer Portal: rotera client secret. Klistra in den nya secret direkt i Supabase-fältet `FORTNOX_CLIENT_SECRET`. Registrera redirect-URI `https://localhost/fortnox-callback`. Scopes som behövs: `bookkeeping`, `invoice`, `supplierinvoice`, `payment`, `customer`, `supplier`, `inbox`, `archive`, `connectfile`, `companyinformation`. Ta inte med `settings`. [Fortnox scopes](https://www.fortnox.se/developer/guides-and-good-to-know/scopes).
4. Öppna godkännandelänken i webbläsaren. Byt `<FORTNOX_CLIENT_ID>` mot samma client id som du lade i Supabase. Client id är inte secret. Secret ska inte in i länken. `access_type=offline` gör att Fortnox ger en refresh token. Sidan på localhost kommer inte att ladda. Kopiera hela adressen i adressfältet ändå. Den innehåller `code`.

```text
https://apps.fortnox.se/oauth-v1/auth?client_id=<FORTNOX_CLIENT_ID>&redirect_uri=https%3A%2F%2Flocalhost%2Ffortnox-callback&scope=bookkeeping%20invoice%20supplierinvoice%20payment%20customer%20supplier%20inbox%20archive%20connectfile%20companyinformation&access_type=offline&response_type=code
```

Vill du att gatewayen ska kräva `state`, lägg samma värde i hemligheten `FORTNOX_OAUTH_STATE` och som `&state=` i länken. Lämna hemligheten tom om du inte använder det.

5. På din Mac, i katalogen där `golive.sh` ligger:

```bash
bash supabase/functions/finance-gateway/golive.sh
```

Skriptet frågar efter admin-token (den syns inte), project ref, och adressen du kopierade. Det anropar bara Supabase. Funktionen byter koden hos Fortnox. Du ska se scopes, inte någon token.

6. Fortsätt med samma skript, fortfarande på din Mac:

```bash
bash supabase/functions/finance-gateway/golive.sh create-agent
bash supabase/functions/finance-gateway/golive.sh set-policy
```

`create-agent` visar Eriks token en gång. Ge den till Erik och spara den inte i git. `set-policy` frågar efter beloppsgränsen (förslag 10000) och räkenskapsåret. Bekräfta 10 000 SEK per rad för ombokning, periodisering och nedskrivning, eller skriv ett annat tal.

7. När checklistan längre ner är grön:

```bash
bash supabase/functions/finance-gateway/golive.sh kill-switch off
```

`kill-switch on` slår på stoppet igen. `audit` visar loggen utan Fortnox-token.

8. Om Fortnox client secret, admin-token eller refresh token fortfarande ligger på den delade Linux-burken från tidigare, ta bort dem. Den här vägen lägger dem inte där.

## Vad Minnes-Mattias gör

Mattias applicerar migrationen, deployar funktionen och kontrollerar RLS. Han hanterar inte värdena för Fortnox client secret, client id, admin-token eller OAuth-token. De sätter David i dashboarden. `supabase secrets list` visar namn, inte värden, och räcker om Mattias vill se att namnen finns.

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

4. Deploya, utan att sätta Fortnox-secret eller admin-token:

```bash
supabase functions deploy finance-gateway --no-verify-jwt
```

`FORTNOX_REDIRECT_URI` behöver inte sättas om redirecten är `https://localhost/fortnox-callback`. Den är standard i funktionen.

5. Kontrollera att en GET utan bearer ger 401, att DELETE mot en betalning ger `delete_forbidden`, och att en verifikation i dry-run inte syns i Fortnox.
6. Access token och refresh token ska bara finnas i `finance_oauth_tokens` efter Davids `golive.sh`. Lägg dem inte i funktionsloggar, i en `.env` på burken, eller i en annan tabell med policy för `authenticated`.

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` finns redan i Edge Functions-miljön.

## Go-live-checklista

- [ ] PR mergad av en människa. Migrationen är inte körd före det.
- [ ] RLS forced och grants verifierade.
- [ ] David har lagt client id, client secret och admin-token i Supabase-dashboarden. Mattias har inte sett värdena.
- [ ] Client secret roterad i Fortnox och inklistrad direkt i Supabase. Gamla secret är död.
- [ ] Appen om-auktoriserad utan `settings`. David körde `golive.sh` med redirect-adressen. Svaret visade scopes och ingen token.
- [ ] Eriks agent-token utfärdad med `golive.sh create-agent` och lagrad bara hos Erik. Hash i `finance_agents`.
- [ ] Räkenskapsår satt. Beloppsgränsen 10 000 SEK bekräftad eller ändrad.
- [ ] Dry-run av en vanlig verifikation ger `dry_run` och inget Fortnox-anrop.
- [ ] Ett anrop mot ett ASK-konto utan godkännande ger `ask_account`.
- [ ] DELETE och `/3/settings/company` vägras.
- [ ] Nödstoppet slås av av David.
- [ ] Eventuella gamla Fortnox-credentials och admin-token är borta från den delade Linux-burken. De har inte lagts dit i den här vägen.

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

Testerna mockar Fortnox. De täcker allowlist, DELETE, inställningar, ASK-konto, engångs- och utgånget godkännande, period, beloppsgräns, nödstopp, felaktig agent-token, dry-run utan anrop, att en roterad refresh token sparas, och att `exchange-code` tar en kod eller en redirect-URL, sparar token och bara returnerar scopes.

## Driftstatus

Funktionen är inte deployad. Migrationen är inte applicerad. Inga riktiga kundnummer, organisationsnummer eller Fortnox-uppgifter finns i repot.
