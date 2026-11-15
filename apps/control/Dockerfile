# Node 22 (LTS) — Node 20 ist seit dem 30.04.2026 End-of-Life ([A.18]).
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
# shared zuerst bauen, dann den eigenen Prisma-Client erzeugen (liefert die
# TS-Typen), dann NUR das Backend bauen. `build` wuerde auch `vite build`
# ausfuehren — das gehoert ins Web-Image, nicht hierher.
RUN pnpm --filter @saas-instant/shared build \
 && pnpm --filter @saas-instant/control exec prisma generate \
 && pnpm --filter @saas-instant/control build:api

FROM node:22-alpine
# OpenSSL für die Prisma-Engine auf Alpine (sonst libssl-Fehler bei migrate deploy).
RUN apk add --no-cache openssl
RUN npm install -g pnpm@11.9.0
# Prisma-CLI global für `migrate deploy` beim Container-Start (als
# Prod-Dependency liegt nur @prisma/client vor, nicht die CLI).
RUN npm install -g prisma@5.22.0
WORKDIR /app
# Lockfile mitnehmen ([A.16]) — sonst loest pnpm die Bereiche aus den
# package.json frisch auf und das Laufzeit-Image weicht vom geprueften Build ab.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Beide Workspace-Pakete, die apps/control als dependency fuehrt, muessen mit
# ihrer package.json im Image liegen — sonst bricht `pnpm install --prod` mit
# ERR_PNPM_WORKSPACE_PKG_NOT_FOUND ab. @saas-instant/ui wird nur vom Web-Bundle
# gebraucht; hier genuegt die package.json, damit der Workspace aufloest.
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY apps/control/package.json ./apps/control/
RUN pnpm install --prod --frozen-lockfile --filter @saas-instant/control
# Gebautes shared-Paket mitliefern (main = ./dist/index.js).
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/control/dist ./apps/control/dist
COPY --from=build /app/apps/control/prisma ./apps/control/prisma
# Prisma-Client für die Laufzeit erzeugen (globale CLI-Version = Client-Version).
RUN cd apps/control && prisma generate
# BAUZEITPUNKT INS IMAGE ([Versionsauskunft]). Coolify liefert den Commit als
# SOURCE_COMMIT, aber keinen Bauzeitpunkt. Diese Schicht liegt hinter dem COPY
# des gebauten Codes: Sie wird bei jedem echten Bau neu ausgefuehrt und bei
# einem reinen Cache-Treffer uebersprungen — genau das gewuenschte Verhalten.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > ./apps/control/BUILD_TIME

COPY apps/control/docker-entrypoint.sh ./apps/control/docker-entrypoint.sh
RUN chmod +x ./apps/control/docker-entrypoint.sh

# NICHT ALS ROOT LAUFEN ([A.18]). Der Rechnungsdienst macht es vor; hier fehlte
# es. Die Verwaltung schreibt zur Laufzeit in kein Verzeichnis — sie braucht
# deshalb auch keines uebereignet.
USER node

WORKDIR /app/apps/control
EXPOSE 3001
# Healthcheck gegen GET /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
