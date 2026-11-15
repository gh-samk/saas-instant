import {
  BLOCKED_SUBDOMAINS,
  SUBDOMAIN_MAX,
  normalizeSubdomain,
  subdomainError,
  subdomainSuggestion,
} from './subdomain';

describe('subdomainSuggestion', () => {
  it('macht aus dem Organisationsnamen einen brauchbaren Vorschlag', () => {
    expect(subdomainSuggestion('Musterverein Ostend e. V.')).toBe(
      'musterverein-ostend',
    );
    expect(subdomainSuggestion('Wohnprojekt Grünzug GmbH')).toBe(
      'wohnprojekt-gruenzug',
    );
  });

  it('übersetzt Umlaute statt sie zu verschlucken', () => {
    expect(subdomainSuggestion('Höfe & Gärten')).toBe('hoefe-gaerten');
    expect(normalizeSubdomain('Straßenfest')).toBe('strassenfest');
  });

  it('liefert auch bei einem Namen aus lauter Füllwörtern etwas', () => {
    expect(subdomainSuggestion('e. V.')).toBe('e-v');
  });

  it('bleibt innerhalb der DNS-Grenze und endet nie auf einem Bindestrich', () => {
    const long = subdomainSuggestion('Ab'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(SUBDOMAIN_MAX);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('subdomainError', () => {
  it('lässt zulässige Werte durch', () => {
    expect(subdomainError('musterverein-ostend')).toBeNull();
    expect(subdomainError('a1')).toBeNull();
  });

  it('weist leere, zu lange und falsch geschriebene Werte ab', () => {
    expect(subdomainError('')).not.toBeNull();
    expect(subdomainError('a'.repeat(SUBDOMAIN_MAX + 1))).not.toBeNull();
    expect(subdomainError('-anfang')).not.toBeNull();
    expect(subdomainError('ende-')).not.toBeNull();
    expect(subdomainError('Groß')).not.toBeNull();
    expect(subdomainError('mit punkt.drin')).not.toBeNull();
  });

  it('sperrt die Adressen des Betriebs', () => {
    for (const blocked of BLOCKED_SUBDOMAINS) {
      expect(subdomainError(blocked)).not.toBeNull();
    }
  });
});
