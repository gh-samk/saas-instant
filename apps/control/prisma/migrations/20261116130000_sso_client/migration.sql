-- Anmeldung ueber das Portal (SSO, Modus "portal"), Client-Seite.
--
-- Rein additiv: bestehende Konten behalten ihr Verhalten (accessRole = admin,
-- emergency = false, keine SSO-Verknuepfung). Im Modus "single" werden die
-- neuen Spalten und Tabellen nicht gelesen.

CREATE TYPE "AccessRole" AS ENUM ('admin', 'staff');

ALTER TABLE "User" ADD COLUMN "ssoSubject" TEXT;
ALTER TABLE "User" ADD COLUMN "ssoIssuer" TEXT;
ALTER TABLE "User" ADD COLUMN "accessRole" "AccessRole" NOT NULL DEFAULT 'admin';
ALTER TABLE "User" ADD COLUMN "emergency" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");

CREATE TABLE "SsoSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ssoSid" TEXT NOT NULL,
    "stepUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SsoSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SsoSession_ssoSid_idx" ON "SsoSession"("ssoSid");
CREATE INDEX "SsoSession_userId_idx" ON "SsoSession"("userId");

ALTER TABLE "SsoSession" ADD CONSTRAINT "SsoSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SsoAttempt" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SsoAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SsoAttempt_stateHash_key" ON "SsoAttempt"("stateHash");
