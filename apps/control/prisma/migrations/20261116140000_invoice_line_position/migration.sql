-- Reihenfolge der Rechnungsposten (M11). Rein additiv und bewusst OHNE
-- Nachtrag: Der GoBD-Trigger "InvoiceLine_gobd_no_update" verbietet jede
-- Änderung an Posten festgeschriebener Rechnungen, und InvoiceLine hat keinen
-- Zeitstempel, aus dem eine frühere Reihenfolge ableitbar wäre. Altposten
-- behalten NULL und werden weiter nach Id sortiert; neue Posten tragen die
-- Position ab 0.
ALTER TABLE "InvoiceLine" ADD COLUMN "position" INTEGER;

-- Fälligkeit von Hand gesetzt oder aus dem Zahlungsziel abgeleitet (M16).
-- Additiv; Bestandszeilen gelten als von Hand gesetzt und bleiben unverändert.
-- ADD COLUMN löst keine Zeilentrigger aus, der GoBD-Schutz bleibt unberührt.
ALTER TABLE "Invoice" ADD COLUMN "dueDateManual" BOOLEAN NOT NULL DEFAULT true;
