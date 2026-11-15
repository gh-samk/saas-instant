import { keyMatches } from './key';

describe('keyMatches', () => {
  it('erkennt den richtigen Schlüssel', () => {
    expect(keyMatches('geheim-123', 'geheim-123')).toBe(true);
  });

  it('weist einen falschen Schlüssel ab', () => {
    expect(keyMatches('geheim-124', 'geheim-123')).toBe(false);
  });

  it('weist einen fehlenden Schlüssel ab', () => {
    expect(keyMatches(undefined, 'geheim-123')).toBe(false);
    expect(keyMatches('', 'geheim-123')).toBe(false);
  });

  it('weist auch bei ABWEICHENDER LÄNGE ab, ohne zu vergleichen zu verweigern', () => {
    // Der Vergleich läuft über die SHA-256-Summen, deshalb sind beide Seiten
    // immer 32 Byte lang und die Länge des Geheimnisses ist nicht ablesbar.
    expect(keyMatches('short', 'ein-sehr-viel-laengerer-schluessel')).toBe(
      false,
    );
    expect(
      keyMatches('ein-sehr-viel-laengerer-schluessel-plus', 'short'),
    ).toBe(false);
  });

  it('ist ohne eingerichtetes Geheimnis niemals wahr', () => {
    // Sonst hätte eine leere Umgebungsvariable jeden hereingelassen, der
    // ebenfalls nichts schickt.
    expect(keyMatches('', '')).toBe(false);
    expect(keyMatches(undefined, '')).toBe(false);
  });
});
