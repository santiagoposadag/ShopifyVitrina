# syntax=docker/dockerfile:1
#
# Build context MUST be the repo root (this is an npm-workspaces monorepo):
#   docker build -f server/Dockerfile -t vitrina-server .
# or via compose.yaml, which already sets context: . for this file.

# NODE_ENV is deliberately NOT set here. npm defaults `omit` to `dev` whenever
# NODE_ENV=production, which would strip typescript from the build stage and
# break `tsc`. Each stage below opts in explicitly.
FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# prod-deps: production-only node_modules for the runtime image.
# better-sqlite3 is a native module; python3/make/g++ let node-gyp compile it
# from source when no prebuilt binary matches this platform/Node ABI.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci -w server --include-workspace-root --omit=dev
# Guard against a hoisted install layout where server/node_modules never gets
# created — the runtime stage COPY below must not fail on a missing dir.
RUN mkdir -p /app/server/node_modules

# ---------------------------------------------------------------------------
# build: full deps (incl. devDependencies) + TypeScript compile to dist/.
# ---------------------------------------------------------------------------
FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci -w server --include-workspace-root
COPY server/ server/
RUN npm run build -w server

# ---------------------------------------------------------------------------
# runtime: minimal image — compiled JS + prod node_modules + seed source data.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY package.json ./
COPY server/package.json server/package.json
# Source data the seed job reads photos/messages from — needed at runtime
# because `seed` is a separate compose service built from this same image.
COPY propiedad_1/ propiedad_1/
COPY propiedad_2/ propiedad_2/

# /data holds the SQLite db and media; /home/node/.claude is where the Agent SDK
# writes its session transcripts. BOTH are named-volume mountpoints in
# compose.yaml, and both MUST exist here owned by node: a named volume inherits
# the ownership of the image directory it covers, but when that directory does
# not exist in the image Docker creates the mountpoint as root and the non-root
# process below cannot write to it.
RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /home/node/.claude
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
