#!/usr/bin/env bash
# David kör detta på sin egen Mac efter att funktionen är deployad.
# Skriptet innehåller inga hemligheter och skriver inget till disk.
# Klistra inte in Fortnox client secret här. Kör inte skriptet med bash -x.
set -euo pipefail

usage() {
  cat <<'EOF'
Användning (på din egen Mac):
  ./golive.sh
  ./golive.sh exchange
  ./golive.sh create-agent
  ./golive.sh set-policy
  ./golive.sh kill-switch on
  ./golive.sh kill-switch off
  ./golive.sh audit

exchange frågar efter admin-token, project ref och adressen från webbläsaren.
De andra kommandona frågar efter admin-token och project ref.
Admin-token syns inte när du skriver den. Inget sparas i en fil.
EOF
}

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

prompt_secret() {
  local __value
  read -r -s -p "$1" __value
  printf '\n' >&2
  if [[ -z "$__value" ]]; then
    die "Tomt värde."
  fi
  printf '%s' "$__value"
}

prompt_line() {
  local __value
  read -r -p "$1" __value
  printf '%s' "$__value"
}

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

require_session() {
  ADMIN_TOKEN=$(prompt_secret "Admin-token (syns inte, spara den i lösenordshanteraren): ")
  if [[ "$ADMIN_TOKEN" == *\"* || "$ADMIN_TOKEN" == *\\* || "$ADMIN_TOKEN" == *$'\n'* || "$ADMIN_TOKEN" == *$'\r'* ]]; then
    die "Admin-token innehåller ett tecken som skriptet inte skickar."
  fi
  PROJECT_REF=$(prompt_line "Supabase project ref: ")
  if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{8,40}$ ]]; then
    die "Project ref ska vara de korta tecknen från Supabase, till exempel abcdefghijklmnop."
  fi
}

reject_secrets() {
  local body=$1
  if [[ "$body" == *access_token* || "$body" == *refresh_token* || "$body" == *refreshToken* || "$body" == *client_secret* || "$body" == *clientSecret* ]]; then
    die "Svaret innehöll en Fortnox-hemlighet och visas inte."
  fi
}

gateway() {
  local method=$1 path=$2 data=${3:-}
  local url="https://${PROJECT_REF}.supabase.co/functions/v1/finance-gateway${path}"
  local response
  if [[ -n "$data" ]]; then
    response=$(curl --silent --show-error \
      --request "$method" \
      --config <(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$ADMIN_TOKEN") \
      --data-binary "$data" \
      --write-out $'\n__HTTP__%{http_code}' \
      "$url") || die "Kunde inte nå gatewayen."
  else
    response=$(curl --silent --show-error \
      --request "$method" \
      --config <(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$ADMIN_TOKEN") \
      --write-out $'\n__HTTP__%{http_code}' \
      "$url") || die "Kunde inte nå gatewayen."
  fi
  local marker=$'\n__HTTP__'
  HTTP_CODE=${response##*"$marker"}
  BODY=${response%"$marker$HTTP_CODE"}
  reject_secrets "$BODY"
}

json_string() {
  local json=$1 key=$2
  local pattern="\"${key}\":\"([^\"]*)\""
  if [[ $json =~ $pattern ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

require_ok() {
  if [[ "$BODY" != *'"ok":true'* ]]; then
    local reason
    reason=$(json_string "$BODY" reason || true)
    if [[ -n "$reason" ]]; then
      die "Misslyckades: ${reason}"
    fi
    die "Misslyckades (HTTP ${HTTP_CODE})."
  fi
}

cmd_exchange() {
  require_session
  local redirect
  redirect=$(prompt_line "Klistra in hela adressen från webbläsaren: ")
  if [[ "$redirect" == *$'\n'* || "$redirect" == *$'\r'* || "$redirect" == *\"* ]]; then
    die "Adressen kan inte skickas. Klistra in en rad utan citattecken."
  fi
  if [[ ! "$redirect" =~ ^https:// ]]; then
    die "Adressen ska börja med https://"
  fi
  gateway POST /admin/oauth/exchange-code "{\"redirectUrl\":\"$(json_escape "$redirect")\"}"
  require_ok
  local scopes=""
  if [[ $BODY =~ \"scopes\":\[([^\]]*)\] ]]; then
    scopes=${BASH_REMATCH[1]//\"/}
    scopes=${scopes//,/ }
  fi
  printf 'Fortnox är kopplat. Scopes:%s\nInga token visades.\n' "${scopes:+ $scopes}"
}

cmd_create_agent() {
  require_session
  local name
  name=$(prompt_line "Namn på agenten [Ekonomi-Erik]: ")
  if [[ -z "$name" ]]; then
    name="Ekonomi-Erik"
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9\ ._-]{2,80}$ ]]; then
    die "Namnet får innehålla bokstäver, siffror, punkt, bindestreck och understreck."
  fi
  gateway POST /admin/agents "{\"name\":\"$(json_escape "$name")\"}"
  require_ok
  local token agent_id
  token=$(json_string "$BODY" token) || die "Ingen agent-token i svaret."
  agent_id=$(json_string "$BODY" agentId || true)
  printf 'Agent-id: %s\n' "$agent_id"
  printf 'Ge den här token till Erik en gång. Den visas inte igen:\n%s\n' "$token"
}

cmd_set_policy() {
  require_session
  local threshold start_date end_date
  threshold=$(prompt_line "Beloppsgräns i SEK [10000]: ")
  if [[ -z "$threshold" ]]; then
    threshold="10000"
  fi
  if [[ ! "$threshold" =~ ^[0-9]+([.][0-9]{1,2})?$ ]]; then
    die "Beloppet ska vara ett tal, till exempel 10000."
  fi
  start_date=$(prompt_line "Räkenskapsår från (YYYY-MM-DD): ")
  end_date=$(prompt_line "Räkenskapsår till (YYYY-MM-DD): ")
  if [[ ! "$start_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ || ! "$end_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    die "Datum ska vara YYYY-MM-DD."
  fi
  if [[ "$start_date" > "$end_date" ]]; then
    die "Startdatum ligger efter slutdatum."
  fi
  gateway POST /admin/policy "{\"amountThresholdSek\":${threshold},\"financialYearStart\":\"${start_date}\",\"financialYearEnd\":\"${end_date}\"}"
  require_ok
  printf 'Policy sparad. Beloppsgräns %s SEK, räkenskapsår %s till %s.\n' "$threshold" "$start_date" "$end_date"
}

cmd_kill_switch() {
  local mode=${1:-}
  if [[ "$mode" != "on" && "$mode" != "off" ]]; then
    die "Skriv: ./golive.sh kill-switch on   eller   ./golive.sh kill-switch off"
  fi
  require_session
  local engaged="false" label="av"
  if [[ "$mode" == "on" ]]; then
    engaged="true"
    label="på"
  fi
  gateway POST /admin/kill-switch "{\"engaged\":${engaged},\"reason\":\"go-live\"}"
  require_ok
  printf 'Nödstopp är %s.\n' "$label"
}

cmd_audit() {
  require_session
  gateway GET "/admin/audit?limit=20"
  if [[ "$HTTP_CODE" != "200" ]]; then
    die "Misslyckades (HTTP ${HTTP_CODE})."
  fi
  printf '%s\n' "$BODY"
}

main() {
  local cmd=${1:-exchange}
  case "$cmd" in
    exchange|"")
      cmd_exchange
      ;;
    create-agent)
      cmd_create_agent
      ;;
    set-policy)
      cmd_set_policy
      ;;
    kill-switch)
      cmd_kill_switch "${2:-}"
      ;;
    audit)
      cmd_audit
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      die "Okänt kommando: ${cmd}"
      ;;
  esac
  unset ADMIN_TOKEN PROJECT_REF BODY HTTP_CODE
}

main "$@"
