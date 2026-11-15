-- Darstellung des Ausstellers (Briefkopf-/Bank-/Pflichtzeilen, Logo, Akzentfarbe,
-- Rechtsform) wird beim Festschreiben eingefroren. Der GoBD-Trigger
-- gobd_guard_invoice_update lässt jede Spalte ausser seinen Allowlists nach dem
-- Festschreiben unverändert; die neue Spalte fällt darunter und ist damit
-- unveränderlich. Altzeilen behalten NULL (Rückfall: aktuelles Firmenprofil).
ALTER TABLE "Invoice" ADD COLUMN "issuerLayout" JSONB;
