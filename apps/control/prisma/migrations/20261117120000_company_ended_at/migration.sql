-- Seit wann eine Organisation beendet ist: die automatische Löschung wartet 90 Tage danach. Additiv.
ALTER TABLE "Company" ADD COLUMN "endedAt" DATE;

-- Startwert für bereits beendete Organisationen: HEUTE. Das Wechseldatum wäre genauer, stammt aber bei
-- ehemals ruhenden Organisationen (dormant -> ended) aus einem anderen Sinn; ein Startwert „heute"
-- macht beim Einspielen nichts sofort fällig.
UPDATE "Company" SET "endedAt" = CURRENT_DATE WHERE "status" = 'ended';
