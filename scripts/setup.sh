#!/usr/bin/env bash
# One-time local setup: dependencies, .env with generated secrets, database, seed data.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Installing dependencies"
npm install --no-audit --no-fund

if [ ! -f .env ]; then
  echo "→ Creating .env"
  cp .env.example .env
  secret=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
  # portable in-place edit (macOS + Linux)
  node -e '
    const fs=require("fs");let s=fs.readFileSync(".env","utf8");
    s=s.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${process.argv[1]}"`);
    if (!process.env.CI) s=s.replace(/^AUTH_DEV_LOGIN=.*$/m, "AUTH_DEV_LOGIN=\"true\"");
    fs.writeFileSync(".env", s);' "$secret"
  echo "  AUTH_DEV_LOGIN=true for local development (no Entra needed). Run scripts/entra-register.sh to enable Microsoft sign-in."
fi

mkdir -p data
echo "→ Creating database schema"
npx prisma db push --skip-generate >/dev/null
npx prisma generate >/dev/null
echo "→ Seeding workspace, templates, sample library and demo project"
npm run db:seed
echo
echo "Done. Start with:  npm run dev   → http://localhost:3000"
