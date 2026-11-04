# Build-Kontext ist das Repo-Wurzelverzeichnis:
#   docker build -f apps/worker/Dockerfile -t stammbuch-worker .

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @stammbuch/shared run build \
 && pnpm --filter @stammbuch/worker run build \
 && pnpm --filter @stammbuch/worker deploy --prod /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Kein Port: der Worker nimmt keine Verbindungen an. SIGTERM beendet ihn geordnet.
CMD ["node", "dist/main.js"]
