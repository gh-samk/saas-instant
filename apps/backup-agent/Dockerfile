# Backup-Agent von saas-instant. Build-Kontext = Repository-Wurzel:
#   docker build -f apps/backup-agent/Dockerfile -t saas-instant-backup-agent .
#
# Node 22 (LTS). Zur Laufzeit braucht der Agent pg_dump (Verwaltungs-DB) und
# kein anderes Werkzeug: Instanz-Dumps laufen per Exec IM Datenbank-Container.
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter @saas-instant/backup-agent \
 && pnpm --filter @saas-instant/backup-agent build

FROM node:22-alpine
# pg_dump fuer die Verwaltungs-DB (Server: postgres:16; ein neuerer Client ist abwaertskompatibel).
RUN apk add --no-cache postgresql-client tini \
 && npm install -g pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backup-agent/package.json ./apps/backup-agent/
RUN pnpm install --prod --frozen-lockfile --filter @saas-instant/backup-agent \
 && pnpm store prune
COPY --from=build /app/apps/backup-agent/dist ./apps/backup-agent/dist

# NICHT ALS ROOT LAUFEN. Zustand liegt im Volume /state (Arbeitsdateien in /state/work).
RUN addgroup -S -g 10002 agent && adduser -S -u 10002 -G agent -h /state agent \
 && mkdir -p /state/work && chown -R 10002:10002 /state
USER 10002:10002
WORKDIR /app/apps/backup-agent
ENV NODE_ENV=production \
    PORT=8787 \
    STATE_DIR=/state \
    WORK_DIR=/state/work
VOLUME ["/state"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
