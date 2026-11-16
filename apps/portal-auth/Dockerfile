# Anmeldedienst des Portals (OIDC-Anbieter). Build-Kontext: Wurzel des Repos
#   docker build -f apps/portal-auth/Dockerfile .
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
# auth-core zuerst (main = ./dist/index.js), dann Prisma-Client (Typen), dann der Dienst.
RUN pnpm --filter @saas-instant/auth-core build \
 && pnpm --filter @saas-instant/portal-auth exec prisma generate \
 && pnpm --filter @saas-instant/portal-auth build

FROM node:22-alpine
# OpenSSL für die Prisma-Engine auf Alpine.
RUN apk add --no-cache openssl
RUN npm install -g pnpm@11.9.0
# Prisma-CLI global für `migrate deploy` beim Start (zur Laufzeit liegt nur @prisma/client vor).
RUN npm install -g prisma@5.22.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/auth-core/package.json ./packages/auth-core/
COPY apps/portal-auth/package.json ./apps/portal-auth/
RUN pnpm install --prod --frozen-lockfile --filter "@saas-instant/portal-auth..."
COPY --from=build /app/packages/auth-core/dist ./packages/auth-core/dist
COPY --from=build /app/apps/portal-auth/dist ./apps/portal-auth/dist
COPY --from=build /app/apps/portal-auth/prisma ./apps/portal-auth/prisma
RUN cd apps/portal-auth && prisma generate
COPY apps/portal-auth/docker-entrypoint.sh ./apps/portal-auth/docker-entrypoint.sh
RUN chmod +x ./apps/portal-auth/docker-entrypoint.sh

# Nicht als root laufen; der Dienst schreibt zur Laufzeit in kein Verzeichnis.
USER node
WORKDIR /app/apps/portal-auth
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/api/health || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
