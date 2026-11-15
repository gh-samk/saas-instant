import type { ConfigService } from '@nestjs/config';
import { checkBilling } from '../../manifest/sections/billing';
import type { ManifestService } from '../../manifest/manifest.service';
import {
  ISSUER_PRESETS,
  IssuerConfigService,
  isPlaceholderIssuer,
} from './issuer.config';

const env = (values: Record<string, string> = {}) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

function withManifest(billing: unknown, values: Record<string, string> = {}) {
  const error: string[] = [];
  const parsed = checkBilling(billing, error);
  expect(error).toEqual([]);
  return new IssuerConfigService(env(values), {
    billing: parsed,
  } as unknown as ManifestService);
}

describe('Platzhalter-Aussteller', () => {
  it('erkennt die Vorgaben aus dem Quelltext', () => {
    expect(isPlaceholderIssuer(ISSUER_PRESETS)).toBe(true);
    expect(isPlaceholderIssuer(new IssuerConfigService(env()).read())).toBe(true);
  });

  it('erkennt jeden einzelnen Platzhalterwert', () => {
    const real = withManifest(
      {
        issuer: {
          name: 'Testhaus GmbH',
          taxId: 'DE811569869',
          iban: 'DE89370400440532013000',
        },
      },
    ).read();
    expect(isPlaceholderIssuer(real)).toBe(false);
    expect(isPlaceholderIssuer({ ...real, name: 'Example Company' })).toBe(true);
    expect(isPlaceholderIssuer({ ...real, vatId: ISSUER_PRESETS.vatId })).toBe(true);
    expect(
      isPlaceholderIssuer({ ...real, bank: { ...real.bank, iban: 'DE02 1203 0000 0000 2020 51' } }),
    ).toBe(true);
  });

  it('gilt nicht mehr als Platzhalter, sobald Umgebung oder Manifest echte Werte liefern', () => {
    const viaEnv = new IssuerConfigService(
      env({
        CONTROL_INVOICE_ISSUER: 'Testhaus GmbH',
        CONTROL_INVOICE_USTIDNR: 'DE811569869',
        CONTROL_INVOICE_IBAN: 'DE89370400440532013000',
      }),
    ).read();
    expect(isPlaceholderIssuer(viaEnv)).toBe(false);
  });
});

describe('Rechtsform und Aufbewahrung aus Manifest/Umgebung', () => {
  it('Standard: Gesellschaft und acht Jahre', () => {
    const service = new IssuerConfigService(env());
    expect(service.read().legalForm).toBe('company');
    expect(service.retentionYears()).toBe(8);
    expect(withManifest({}).read().legalForm).toBe('company');
    expect(withManifest({}).retentionYears()).toBe(8);
  });

  it('liest legalForm und retentionYears aus dem Manifest', () => {
    const service = withManifest({
      issuer: { name: 'Max Muster', legalForm: 'sole_proprietor' },
      retentionYears: 10,
    });
    expect(service.read().legalForm).toBe('sole_proprietor');
    expect(service.retentionYears()).toBe(10);
  });

  it('lässt CONTROL_INVOICE_LEGAL_FORM das Manifest überstimmen, ignoriert aber Unsinn', () => {
    const manifest = { issuer: { name: 'X', legalForm: 'sole_proprietor' } };
    expect(
      withManifest(manifest, { CONTROL_INVOICE_LEGAL_FORM: 'association' }).read().legalForm,
    ).toBe('association');
    expect(
      withManifest(manifest, { CONTROL_INVOICE_LEGAL_FORM: 'gmbh' }).read().legalForm,
    ).toBe('sole_proprietor');
  });
});
