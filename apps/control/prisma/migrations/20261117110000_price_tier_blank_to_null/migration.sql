-- Leere Preisstufe war kein Preis, galt aber als vereinbart. Additiv: nur Datenbereinigung.
UPDATE "Company" SET "priceTier" = NULL WHERE "priceTier" ~ '^\s*$';
