import {
  isPlausibleAddress,
  newToken,
  normalizeAddress,
} from './address';

describe('Adressen normalisieren', () => {
  it('macht aus Schreibweisen dieselbe Adresse', () => {
    expect(normalizeAddress('  Anna@Example.COM ')).toBe('anna@example.com');
  });

  /**
   * Ohne diese Zurückhaltung legte die Normalisierung fremde Postfächer
   * zusammen: „a.b@example.com" und „ab@example.com" sind bei den allermeisten
   * Servern zwei verschiedene Menschen.
   */
  it('lässt Punkte und Plus-Zusätze im lokalen Teil unangetastet', () => {
    expect(normalizeAddress('a.b+news@example.com')).toBe('a.b+news@example.com');
  });

  it('erkennt offensichtlich unbrauchbare Adressen', () => {
    expect(isPlausibleAddress('anna@example.com')).toBe(true);
    expect(isPlausibleAddress('anna@example')).toBe(false);
    expect(isPlausibleAddress('anna example.com')).toBe(false);
    expect(isPlausibleAddress('a@b.c')).toBe(false);
  });
});

describe('Token', () => {
  it('ist lang genug, um nicht geraten zu werden', () => {
    // 32 Zufallsbytes als base64url = 43 Zeichen.
    expect(newToken().length).toBeGreaterThanOrEqual(43);
  });

  it('ist ohne Prozentkodierung URL-sicher', () => {
    for (let run = 0; run < 200; run += 1) {
      expect(newToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('wiederholt sich nicht', () => {
    const seen = new Set<string>();
    for (let run = 0; run < 500; run += 1) seen.add(newToken());
    expect(seen.size).toBe(500);
  });
});
