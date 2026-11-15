import { describe, it, expect } from 'vitest';
import { isCorrectable, CORRECTABLE_FIELDS } from './correction';

describe('istKorrigierbar() – Feld-Whitelist', () => {
  it('erlaubt die korrigierbaren Felder je Zieltyp', () => {
    expect(isCorrectable('proposal', 'title')).toBe(true);
    expect(isCorrectable('proposal', 'content')).toBe(true);
    expect(isCorrectable('concerns', 'content')).toBe(true);
    expect(isCorrectable('objection', 'content')).toBe(true);
    expect(isCorrectable('objection', 'integration')).toBe(true);
    expect(isCorrectable('decision', 'content')).toBe(true);
    expect(isCorrectable('decision', 'note')).toBe(true);
  });

  it('lehnt Zeit-/Status-/Gültigkeits-/Governance-/Schweregrad-Felder ab', () => {
    expect(isCorrectable('proposal', 'status')).toBe(false);
    expect(isCorrectable('proposal', 'date')).toBe(false);
    expect(isCorrectable('proposal', 'governanceTyp')).toBe(false);
    expect(isCorrectable('objection', 'severity')).toBe(false);
    expect(isCorrectable('decision', 'gueltigBis')).toBe(false);
    // befristung wird NICHT direkt korrigiert – die Änderung läuft über das Feld
    // ueberpruefungsdatum (leer ⇒ unbefristet, Datum ⇒ befristet).
    expect(isCorrectable('decision', 'term')).toBe(false);
    expect(isCorrectable('decision', 'gueltigkeitStatus')).toBe(false);
  });

  it('erlaubt das Überprüfungsdatum als Befristungs-Korrektur', () => {
    expect(isCorrectable('decision', 'reviewDate')).toBe(true);
  });

  it('lehnt ein Feld ab, das es beim Zieltyp gar nicht gibt', () => {
    expect(isCorrectable('concerns', 'note')).toBe(false);
    expect(isCorrectable('proposal', 'integration')).toBe(false);
  });

  it('deckt genau die dokumentierten Felder ab', () => {
    expect(CORRECTABLE_FIELDS.proposal).toEqual(['title', 'content']);
    expect(CORRECTABLE_FIELDS.concerns).toEqual(['content']);
    expect(CORRECTABLE_FIELDS.objection).toEqual(['content', 'integration']);
    expect(CORRECTABLE_FIELDS.decision).toEqual([
      'content',
      'note',
      'reviewDate',
    ]);
  });
});
