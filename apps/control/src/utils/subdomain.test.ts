import { describe, expect, it } from 'vitest';
import {
  SUBDOMAIN_MAX,
  alternativeSubdomains,
  normalizeSubdomain,
  subdomainFormatError,
} from './subdomain';
import {
  SUBDOMAIN_MAX as SERVER_MAX,
  SUBDOMAIN_PATTERN as SERVER_PATTERN,
  subdomainError as serverError,
} from '../coolify/subdomain';

/**
 * Die Browser-Fassung ist eine SPIEGELUNG der Serverregeln, kein zweiter
 * Regelsatz. Diese Datei ist die Klammer: Läuft eine der beiden Fassungen
 * weg, fällt es hier auf und nicht erst an einer angelegten Instanz.
 *
 * Der Import des Backend-Moduls ist auf Testcode beschränkt — ins
 * Browser-Bündel gerät er nicht (Vitest bündelt nichts nach `dist-web`).
 */
describe('Subdomain-Eingabe', () => {
  it('teilt Höchstlänge und Muster mit dem Server', () => {
    expect(SUBDOMAIN_MAX).toBe(SERVER_MAX);
    for (const value of ['musterverein', 'a', 'a-b-c', 'v2-ostend', 'x9']) {
      expect(SERVER_PATTERN.test(value)).toBe(true);
      expect(subdomainFormatError(value)).toBeNull();
    }
    for (const value of ['-anfang', 'ende-', 'Groß', 'mit punkt', 'a_b']) {
      expect(SERVER_PATTERN.test(value)).toBe(false);
      expect(subdomainFormatError(value)).not.toBeNull();
    }
  });

  it('normalisiert Umlaute und Sonderzeichen wie der Server', () => {
    expect(normalizeSubdomain('Grüne Höfe')).toBe('gruene-hoefe');
    expect(normalizeSubdomain('Straße 1')).toBe('strasse-1');
    // Der führende Rand fällt sofort weg, der abschließende erst mit der
    // Formatprüfung — er ist beim Tippen der nächste Bindestrich.
    expect(normalizeSubdomain('  Café  Süd ')).toBe('cafe-sued-');
    expect(normalizeSubdomain('  Café  Süd')).toBe('cafe-sued');
  });

  it('lässt einen Bindestrich am ENDE stehen — sonst wäre er nicht tippbar', () => {
    // Der Server entfernt ihn; hier bliebe „musterverein-ostend" sonst
    // unerreichbar, weil der Bindestrich nach jedem Tastendruck verschwände.
    expect(normalizeSubdomain('musterverein-')).toBe('musterverein-');
    // Unzulässig ist er trotzdem, und genau das meldet die Formatprüfung.
    expect(subdomainFormatError('musterverein-')).toContain('Anfang');
    expect(serverError('musterverein-')).not.toBeNull();
  });

  it('meldet nichts bei leerem Feld — ein leeres Feld ist kein Fehler', () => {
    expect(subdomainFormatError('')).toBeNull();
  });

  it('kappt bei der Höchstlänge', () => {
    const long = normalizeSubdomain('a'.repeat(200));
    expect(long).toHaveLength(SUBDOMAIN_MAX);
    expect(subdomainFormatError(long)).toBeNull();
    expect(subdomainFormatError(`${long}x`)).toContain('höchstens');
  });

  it('kennt die gesperrten Namen NICHT — das entscheidet der Server', () => {
    // „www" ist formal einwandfrei und trotzdem nicht vergebbar. Die
    // Oberfläche pflegt dafür bewusst keine eigene Liste; die Absage kommt
    // als 400 aus der Verfügbarkeitsprüfung.
    expect(subdomainFormatError('www')).toBeNull();
    expect(serverError('www')).toContain('reserviert');
  });
});

describe('alternativeSubdomains', () => {
  it('zählt ab -2 hoch und setzt eine vorhandene Endzahl fort', () => {
    expect(alternativeSubdomains('muster-testverein', 3)).toEqual([
      'muster-testverein-2',
      'muster-testverein-3',
      'muster-testverein-4',
    ]);
    expect(alternativeSubdomains('muster-2', 2)).toEqual(['muster-3', 'muster-4']);
  });

  it('bleibt unter der Höchstlänge und ist als Subdomain zulässig', () => {
    const long = 'a'.repeat(SUBDOMAIN_MAX);
    for (const candidate of alternativeSubdomains(long)) {
      expect(candidate.length).toBeLessThanOrEqual(SUBDOMAIN_MAX);
      expect(subdomainFormatError(candidate)).toBeNull();
    }
  });
});
