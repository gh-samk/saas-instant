-- Rolle des Backup-Agents in der Verwaltungsdatenbank (wird bei jedem Start von
-- control-db-roles ausgefuehrt, idempotent; Aufruf: psql -v ON_ERROR_STOP=1 -f ...).
--
-- WARUM EINE EIGENE ROLLE: Der Agent braucht die Datenbank nur fuer pg_dump. Als
-- Superuser `control` waere er bei einer Kompromittierung ein vollwertiger
-- Datenbankzugang (Schreiben, Loeschen, Rollen anlegen). Diese Rolle bekommt nur Leserechte:
--   * pg_read_all_data (PostgreSQL 14+): SELECT auf alle Tabellen, Sichten und
--     Sequenzen, auch auf kuenftig angelegte (Migrationen) - genau was pg_dump liest;
--   * kein SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS;
--   * es fehlen alle Schreibrechte; das ist der eigentliche Schutz. default_transaction_read_only
--     ist nur eine Vorgabe, die die Rolle selbst per SET zuruecknehmen koennte.
--
-- Das Passwort kommt aus der Umgebung (BACKUP_DB_PASSWORD), nie aus dieser Datei.
\getenv pw BACKUP_DB_PASSWORD

SELECT format('CREATE ROLE backup_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_agent') \gexec

-- Bei jedem Start angleichen (Passwortwechsel in der .env, Rechte nach manueller Aenderung).
SELECT format('ALTER ROLE backup_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'pw') \gexec

GRANT pg_read_all_data TO backup_agent;
ALTER ROLE backup_agent SET default_transaction_read_only = on;
