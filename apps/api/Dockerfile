# Build-Kontext ist das Repo-Wurzelverzeichnis:
#   docker build -f apps/api/Dockerfile -t stammbuch-api .

FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g corepack && corepack enable

# Zuerst nur die Paketbeschreibungen: der Installationsschritt bleibt im Cache, solange sich
# die Abhängigkeiten nicht ändern.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @stammbuch/shared run build \
 && pnpm --filter @stammbuch/api run build \
 && pnpm --filter @stammbuch/api deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
