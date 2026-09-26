# syntax=docker/dockerfile:1.7
# ── deps ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ── builder (also used by the one-off "seed" service) ─────────────────
FROM deps AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

# ── runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
  && groupadd -r volt && useradd -r -g volt -d /app volt
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DATA_DIR=/app/data
COPY --from=builder --chown=volt:volt /app/.next/standalone ./
COPY --from=builder --chown=volt:volt /app/.next/static ./.next/static
COPY --from=builder --chown=volt:volt /app/public ./public
COPY --from=builder --chown=volt:volt /app/prisma ./prisma
COPY --from=builder --chown=volt:volt /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=volt:volt /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=volt:volt /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=volt:volt scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /app/data && chown volt:volt /app/data && chmod +x ./docker-entrypoint.sh
USER volt
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "server.js"]
