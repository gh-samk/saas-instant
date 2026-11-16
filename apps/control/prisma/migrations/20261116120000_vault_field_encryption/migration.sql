-- Tresor und Feldverschluesselung (W5b).
--
-- 1. Tabelle "Vault": mit KEK (argon2id) verpackte Datenschluessel.
-- 2. Blind-Index-Spalten fuer exakte Treffer auf verschluesselten Feldern.
-- 3. Consent: die Eindeutigkeit je Adresse wandert von "email" (kuenftig
--    Chiffretext mit zufaelligem IV) auf den Blind-Index "emailIdx".
--
-- ALTDATEN: Bestehende Zeilen behalten Klartext und NULL im Blind-Index. NULL ist
-- in einem Unique-Index mehrfach erlaubt, der Umbau kann also nicht an Altdaten
-- scheitern. Bis der Einmal-Lauf "encrypt-existing" (nach dem ersten Entsperren)
-- die Indizes fuellt, gilt fuer Altzeilen die Eindeutigkeit nicht mehr in der
-- Datenbank; die Anwendung prueft sie ueber den Blind-Index (Neuzeilen) und der
-- Lauf bricht bei einer Kollision ab, statt eine Zeile zu ueberschreiben.

CREATE TABLE "Vault" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "userId" TEXT,
    "kdf" TEXT NOT NULL DEFAULT 'argon2id',
    "kdfMemoryKib" INTEGER NOT NULL,
    "kdfTimeCost" INTEGER NOT NULL,
    "kdfParallelism" INTEGER NOT NULL,
    "salt" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Vault_kind_idx" ON "Vault"("kind");

ALTER TABLE "Company" ADD COLUMN "contactEmailIdx" TEXT;
CREATE INDEX "Company_contactEmailIdx_idx" ON "Company"("contactEmailIdx");

ALTER TABLE "MailDelivery" ADD COLUMN "recipientIdx" TEXT;
CREATE INDEX "MailDelivery_recipientIdx_createdAt_idx" ON "MailDelivery"("recipientIdx", "createdAt");

ALTER TABLE "Consent" ADD COLUMN "emailIdx" TEXT;
DROP INDEX "Consent_email_key";
CREATE UNIQUE INDEX "Consent_emailIdx_key" ON "Consent"("emailIdx");
