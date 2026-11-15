import {
  DOMAINS_ALIASES,
  POINTS_IRRELEVANT,
  domainFrom,
  quotaKey,
  quotaParts,
} from './quota-key';

/** Regressionstests zu A.14. */
/** Die Domänen kommen aus der Regeltabelle selbst, nicht als Literal im Test. */
const [POINTS_DOMAIN] = [...POINTS_IRRELEVANT];
const [[ALIAS_DOMAIN]] = Object.entries(DOMAINS_ALIASES);

describe('quotaKey', () => {
  it('vereinheitlicht Schreibweise und Rand-Leerzeichen', () => {
    expect(quotaKey('  Anna@Example.COM ')).toBe('anna@example.com');
  });

  it('legt Plus-Varianten auf dieselbe Adresse — der eigentliche Angriff', () => {
    const base = quotaKey('opfer@example.com');
    expect(quotaKey('opfer+1@example.com')).toBe(base);
    expect(quotaKey('opfer+beliebig+tief@example.com')).toBe(base);
  });

  it('entfernt Punkte NUR bei Gmail', () => {
    expect(quotaKey(`b.e.i.s.p.i.e.l@${POINTS_DOMAIN}`)).toBe(
      `beispiel@${POINTS_DOMAIN}`,
    );
    // Anderswo sind Punkte bedeutungstragend — hier NICHT zusammenlegen.
    expect(quotaKey('a.n.n.a@example.com')).toBe(
      'a.n.n.a@example.com',
    );
  });

  it('legt verschiedene Postfächer NICHT zusammen', () => {
    expect(quotaKey('anna@example.com')).not.toBe(
      quotaKey('anne@example.com'),
    );
    expect(quotaKey('anna@example.com')).not.toBe(
      quotaKey('anna@mail.example.com'),
    );
  });

  it('lässt ein führendes Plus stehen, statt die Adresse zu leeren', () => {
    expect(quotaKey('+seltsam@example.com')).toBe(
      '+seltsam@example.com',
    );
  });

  it('kommt mit Unsinn zurecht, ohne zu werfen', () => {
    expect(quotaKey('ohne-at')).toBe('ohne-at');
    expect(quotaKey('')).toBe('');
    expect(quotaKey('@nur-domaene')).toBe('@nur-domaene');
  });
});

describe('quotaParts', () => {
  /** Review-Hinweis: googlemail.com und gmail.com sind dasselbe Postfach. */
  it('legt Alias- und Hauptdomäne zusammen', () => {
    expect(quotaKey(`b.e.i.s.p.i.e.l@${ALIAS_DOMAIN}`)).toBe(
      `beispiel@${DOMAINS_ALIASES[ALIAS_DOMAIN]}`,
    );
    expect(quotaParts(`beispiel@${ALIAS_DOMAIN}`)?.domainsSpellings.sort()).toEqual(
      [DOMAINS_ALIASES[ALIAS_DOMAIN], ALIAS_DOMAIN].sort(),
    );
  });

  it('nennt bei gewöhnlichen Domänen genau eine Schreibweise', () => {
    expect(quotaParts('x@example.com')?.domainsSpellings).toEqual([
      'example.com',
    ]);
    expect(quotaParts('x@example.com')?.pointsIrrelevant).toBe(false);
  });

  it('gibt bei Unsinn null', () => {
    expect(quotaParts('ohne-at')).toBeNull();
    expect(quotaParts('@nichts')).toBeNull();
    expect(quotaParts('anna@')).toBeNull();
  });
});

describe('domainFrom', () => {
  it('liefert den Domänenteil in Kleinschreibung', () => {
    expect(domainFrom(' Anna@Example.COM ')).toBe('example.com');
  });

  it('liefert null ohne brauchbaren Domänenteil', () => {
    expect(domainFrom('ohne-at')).toBeNull();
    // Leerer lokaler Teil ist keine Adresse — auch dafür kein Schlüssel.
    expect(domainFrom('@nichts')).toBeNull();
    expect(domainFrom('anna@')).toBeNull();
  });
});
