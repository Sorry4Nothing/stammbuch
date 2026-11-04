# Build-Kontext ist das Repo-Wurzelverzeichnis:
#   docker build -f apps/web/Dockerfile -t stammbuch-web .

FROM node:26-alpine AS build
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
 && pnpm --filter @stammbuch/web run build

# nginx-unprivileged läuft als Nicht-Root-Benutzer und lauscht auf Port 8080.
FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY apps/web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
