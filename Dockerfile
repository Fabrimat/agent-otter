# syntax=docker/dockerfile:1
# LessCubicles: build protocol -> web -> server, ship only prod deps + compiled output.
# Build from the repo root:  docker build -t lesscubicles:local .

# ---- 1. manifests only (cache key for the dependency layer) ----
FROM node:22-alpine AS manifests
WORKDIR /src
COPY . .
RUN mkdir /m && { find . -name package.json -not -path '*/node_modules/*'; echo ./pnpm-lock.yaml; echo ./pnpm-workspace.yaml; } \
 | tar -cf - -T - | tar -xf - -C /m

# ---- 2. install + build ----
FROM node:22-alpine AS build
ENV CI=true
# pnpm version comes from "packageManager" in the root package.json (pinned)
RUN corepack enable
WORKDIR /repo
COPY --from=manifests /m ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @lesscubicles/protocol --filter @lesscubicles/web --filter @lesscubicles/server
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/web apps/web
COPY apps/server apps/server
RUN pnpm --filter @lesscubicles/protocol build \
 && pnpm --filter @lesscubicles/web build \
 && pnpm --filter @lesscubicles/server build
# production-only node_modules for the server (protocol is copied with its built dist)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @lesscubicles/server deploy --prod --legacy /out \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/server/migrations /out/migrations \
 && cd /out && node -e "import('@lesscubicles/protocol').then(() => import('./dist/app.js'))"

# ---- 3. runtime ----
FROM node:22-alpine
# HOST=0.0.0.0 is required inside a container (the published port is bound to 127.0.0.1 by compose).
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/dist ./dist
COPY --from=build /out/migrations ./migrations
COPY --from=build /repo/apps/web/dist ./web
# permanent rooms live in one SQLite file under /data (DATABASE_PATH); everything else is memory-only, so --read-only works once /data is a volume
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
# node:sqlite is still flagged experimental on Node 22: the flag silences experimental warnings (all of them)
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
