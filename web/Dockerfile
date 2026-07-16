# syntax=docker/dockerfile:1
#
# Build context MUST be the repo root (this is an npm-workspaces monorepo):
#   docker build -f web/Dockerfile -t vitrina-web .
# or via compose.yaml, which already sets context: . for this file.
#
# next.config.mjs sets serverExternalPackages: ["better-sqlite3"] and does NOT
# use output: "standalone", so the runtime image needs the real node_modules
# (with the compiled native binary), .next/, web/package.json, and the root
# package.json — not a pruned standalone bundle.

# NODE_ENV is deliberately NOT set here. npm defaults `omit` to `dev` whenever
# NODE_ENV=production, which would strip typescript and tailwindcss from the
# build stage and break `next build`. Each stage below opts in explicitly.
# (`next build` forces production mode for its own output regardless.)
FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# prod-deps: production-only node_modules for the runtime image, built on the
# SAME base image as `build` below. Never mix glibc/musl bases here — the
# better-sqlite3 .node binary is ABI- and libc-specific.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
# npm ci reads every workspace manifest declared at the root, shared included.
COPY shared/package.json shared/package.json
RUN npm ci -w web --include-workspace-root --omit=dev
RUN mkdir -p /app/web/node_modules

# ---------------------------------------------------------------------------
# build: full deps (incl. devDependencies) + `next build`.
#
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so they
# MUST arrive as build ARGs promoted to ENV here. Passing them only as
# container `environment:` at runtime silently disables anything that reads
# them (e.g. the WhatsApp CTA).
# ---------------------------------------------------------------------------
FROM base AS build
ARG NEXT_PUBLIC_BRAND_NAME
ARG NEXT_PUBLIC_WHATSAPP_NUMBER
ENV NEXT_PUBLIC_BRAND_NAME=${NEXT_PUBLIC_BRAND_NAME}
ENV NEXT_PUBLIC_WHATSAPP_NUMBER=${NEXT_PUBLIC_WHATSAPP_NUMBER}
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY shared/package.json shared/package.json
RUN npm ci -w web --include-workspace-root
COPY web/ web/
# Type-only workspace: next build's typecheck resolves @vitrina/shared through
# the workspace symlink, which must point at real files. Never needed at runtime.
COPY shared/ shared/
RUN npm run build -w web

# ---------------------------------------------------------------------------
# runtime: prod node_modules + .next build output + package manifests.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/web/node_modules ./web/node_modules
# `next start` lazily writes under .next/cache, so it must be owned by `node`.
COPY --from=build --chown=node:node /app/web/.next ./web/.next
COPY package.json ./
COPY web/package.json web/package.json
# Plain .mjs, NOT .ts: `next start` cannot load a TypeScript config without
# typescript installed, and typescript is a devDependency absent from this
# runtime image (Next would try to `yarn add` it at container startup).
COPY web/next.config.mjs web/next.config.mjs

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

CMD ["npm", "start", "-w", "web"]
