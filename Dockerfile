# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 1. deps — install dependencies once, cached separately from source changes
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# 2. builder — build the Next.js app (needs devDependencies + full source)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL isn't needed at build time (no data is fetched during the
# build), but drizzle.config.ts throws if it's unset, and some tooling
# imports it — a placeholder keeps the build hermetic and offline.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npm run build

# ---------------------------------------------------------------------------
# 3. runner — minimal production image: standalone server + traced deps only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next's standalone output (a pruned node_modules + server.js)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets aren't included in `standalone` by design (see Next.js docs
# on output: "standalone") — copied in explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# SQL migrations + the plain-JS runner that applies them at container start.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
# Turbopack bundles pure-JS deps (like drizzle-orm) directly into the
# compiled server chunks, so `standalone/node_modules` doesn't include
# drizzle-orm even though the app needs it — but scripts/migrate.mjs runs
# with plain `node`, outside that bundle, so it needs the real package on
# disk. drizzle-orm itself has zero runtime dependencies of its own
# (verified against its package.json), so copying just this one directory
# is sufficient — no transitive node_modules to worry about.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
