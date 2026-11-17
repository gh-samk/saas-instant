-- Organisations-Status von acht auf fuenf: inquiry, trial, paying, exempt, ended.
-- NICHT ADDITIV: neuer Typ, Spalte per USING umgestellt, alter Typ gedroppt.
-- Abbildung: demo, pilot_approved, pilot_running -> trial; paying, review_pending
-- -> paying; dormant, ended -> ended. `exempt` gibt es im Bestand nicht.
CREATE TYPE "CompanyStatus_new" AS ENUM ('inquiry', 'trial', 'paying', 'exempt', 'ended');

DROP INDEX "Company_status_idx";
ALTER TABLE "Company" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Company" ALTER COLUMN "status" TYPE "CompanyStatus_new" USING (
  CASE "status"::text
    WHEN 'inquiry' THEN 'inquiry'
    WHEN 'demo' THEN 'trial'
    WHEN 'pilot_approved' THEN 'trial'
    WHEN 'pilot_running' THEN 'trial'
    WHEN 'paying' THEN 'paying'
    WHEN 'review_pending' THEN 'paying'
    WHEN 'dormant' THEN 'ended'
    WHEN 'ended' THEN 'ended'
  END
)::"CompanyStatus_new";
DROP TYPE "CompanyStatus";
ALTER TYPE "CompanyStatus_new" RENAME TO "CompanyStatus";
ALTER TABLE "Company" ALTER COLUMN "status" SET DEFAULT 'inquiry';
CREATE INDEX "Company_status_idx" ON "Company"("status");
