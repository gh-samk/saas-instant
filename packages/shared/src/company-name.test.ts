import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  normalizeCompanyName,
  companyNameFingerprint,
} from './company-name';

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('normalisiereOrganisationsname', () => {
  it('hält Schreibweisen desselben Namens zusammen', () => {
    const core = normalizeCompanyName('Musterverein Ostend e. V.');
    expect(normalizeCompanyName('Musterverein Ostend e.V.')).toBe(core);
    expect(normalizeCompanyName('  musterverein  ostend  eV ')).toBe(core);
    expect(normalizeCompanyName('MUSTERVEREIN-OSTEND-EV')).toBe(core);
  });

  it('löst Umlaute und Akzente auf', () => {
    expect(normalizeCompanyName('Wohnprojekt Grünzug')).toBe(
      'wohnprojektgruenzug',
    );
    expect(normalizeCompanyName('Höfe & Gärten')).toBe('hoefegaerten');
    expect(normalizeCompanyName('Straßenfest')).toBe('strassenfest');
  });

  it('unterscheidet einen wirklich anderen Namen', () => {
    expect(normalizeCompanyName('Musterverein Ostend')).not.toBe(
      normalizeCompanyName('Wohnprojekt Grünzug'),
    );
  });
});

describe('organisationsnameAbdruck', () => {
  it('ist für dieselbe Schreibweise gleich', () => {
    expect(companyNameFingerprint('Musterverein Ostend e. V.', hash)).toBe(
      companyNameFingerprint('musterverein ostend e.V.', hash),
    );
  });

  it('ist für einen anderen Namen verschieden', () => {
    expect(companyNameFingerprint('Musterverein Ostend', hash)).not.toBe(
      companyNameFingerprint('Wohnprojekt Grünzug', hash),
    );
  });

  it('enthält den Namen selbst nicht', () => {
    const fingerprint = companyNameFingerprint('Musterverein Ostend', hash);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.toLowerCase()).not.toContain('musterverein');
  });
});
