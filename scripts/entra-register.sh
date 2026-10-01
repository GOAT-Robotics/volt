#!/usr/bin/env bash
# Creates (or updates) the Microsoft Entra ID app registration for Volt with the Azure CLI and
# writes the client id / secret / issuer into .env.
#
#   az login                                   # once, as a tenant admin (or app developer)
#   scripts/entra-register.sh                  # localhost only
#   scripts/entra-register.sh --url https://volt.example.com   # add production redirect
#
# Group-based access: the token includes security-group object ids ("groups" claim). Map them to
# Volt roles in Administration → Entra groups.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${VOLT_APP_NAME:-Volt}"
URLS=("http://localhost:3000")
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URLS+=("${2%/}"); shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

command -v az >/dev/null || { echo "Azure CLI (az) is required: https://aka.ms/azcli"; exit 1; }
az account show >/dev/null 2>&1 || az login >/dev/null

TENANT=$(az account show --query tenantId -o tsv)
REDIRECTS=()
for u in "${URLS[@]}"; do REDIRECTS+=("$u/api/auth/callback/microsoft-entra-id"); done

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  echo "→ Creating app registration \"$NAME\""
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "${REDIRECTS[@]}" --enable-id-token-issuance true --query appId -o tsv)
  az ad sp create --id "$APP_ID" >/dev/null
else
  echo "→ Updating existing app registration ($APP_ID)"
  az ad app update --id "$APP_ID" --web-redirect-uris "${REDIRECTS[@]}" --enable-id-token-issuance true
fi

# emit security groups in the ID token, and optional claims for email / auth_time
az ad app update --id "$APP_ID" --set groupMembershipClaims=SecurityGroup
az ad app update --id "$APP_ID" --optional-claims '{"idToken":[{"name":"email","essential":false},{"name":"groups","essential":false}]}' >/dev/null
# Microsoft Graph User.Read (delegated)
az ad app permission add --id "$APP_ID" --api 00000003-0000-0000-c000-000000000000 --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope >/dev/null 2>&1 || true
az ad app permission admin-consent --id "$APP_ID" >/dev/null 2>&1 || echo "  (admin consent not granted — users will be asked to consent on first sign-in)"

echo "→ Creating client secret (2 years)"
SECRET=$(az ad app credential reset --id "$APP_ID" --display-name "volt-$(date +%Y%m%d)" --years 2 --append --query password -o tsv)

[ -f .env ] || cp .env.example .env
node -e '
  const fs=require("fs");let s=fs.readFileSync(".env","utf8");
  const set=(k,v)=>{const re=new RegExp(`^${k}=.*$`,"m");s=re.test(s)?s.replace(re,`${k}="${v}"`):s+`\n${k}="${v}"`;};
  set("AUTH_MICROSOFT_ENTRA_ID_ID",process.argv[1]);
  set("AUTH_MICROSOFT_ENTRA_ID_SECRET",process.argv[2]);
  set("AUTH_MICROSOFT_ENTRA_ID_ISSUER",`https://login.microsoftonline.com/${process.argv[3]}/v2.0/`);
  fs.writeFileSync(".env",s);' "$APP_ID" "$SECRET" "$TENANT"

echo
echo "Entra app: $APP_ID (tenant $TENANT)"
echo "Redirect URIs:"; printf '  %s\n' "${REDIRECTS[@]}"
echo ".env updated. For production set AUTH_URL to your public URL and AUTH_DEV_LOGIN=false."
