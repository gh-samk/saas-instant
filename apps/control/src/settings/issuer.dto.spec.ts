import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { emptyIssuerProfile } from '@saas-instant/shared';
import { IssuerUpdateDto } from './dto/issuer.dto';
import { LogoInvalidError, normalizeProfile, sniffLogo } from './issuer-profile.service';

/** Eingabeprüfung der Firmendaten-API: Struktur und Typen streng. */

const VALID = { profile: emptyIssuerProfile('gmbh'), accentColor: '#0369a1' };

async function errorsOf(body: unknown): Promise<string[]> {
  const found = await validate(plainToInstance(IssuerUpdateDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const walk = (e: (typeof found)[number], path: string): string[] => [
    ...(Object.keys(e.constraints ?? {}).length > 0 ? [`${path}${e.property}`] : []),
    ...(e.children ?? []).flatMap((c) => walk(c, `${path}${e.property}.`)),
  ];
  return found.flatMap((f) => walk(f, ''));
}

describe('IssuerUpdateDto', () => {
  it('nimmt ein (auch leeres, unvollständiges) Profil an', async () => {
    expect(await errorsOf(VALID)).toEqual([]);
    expect(await errorsOf({ profile: VALID.profile })).toEqual([]);
    expect(await errorsOf({ profile: VALID.profile, accentColor: null })).toEqual([]);
  });

  it('weist unbekannte Rechtsformen, Typfehler und Zusatzfelder ab', async () => {
    const p = VALID.profile;
    expect(await errorsOf({ profile: { ...p, legalForm: 'ag' } })).toContain('profile.legalForm');
    expect(await errorsOf({ profile: { ...p, name: 42 } })).toContain('profile.name');
    expect(await errorsOf({ profile: { ...p, registered: 'ja' } })).toContain('profile.registered');
    expect(await errorsOf({ profile: { ...p, partners: 'Erika' } })).toContain('profile.partners');
    expect(await errorsOf({ profile: { ...p, partners: [1] } })).toContain('profile.partners');
    expect(await errorsOf({ profile: { ...p, extra: 'x' } }).then((e) => e.length)).toBeGreaterThan(0);
    expect(await errorsOf({ profile: { ...p, generalPartner: 'x' } })).not.toEqual([]);
    expect(await errorsOf({ ...VALID, accentColor: 5 })).toContain('accentColor');
    expect(await errorsOf({ profile: { ...p, name: 'x'.repeat(201) } })).toContain('profile.name');
  });

  it('ergänzt gespeicherte Profile ohne neuere Felder', () => {
    const profile = normalizeProfile({ legalForm: 'gmbh', name: 'A GmbH' });
    expect(profile.generalPartner.name).toBe('');
    expect(profile.partners).toEqual([]);
    expect(normalizeProfile(null).legalForm).toBe('einzelunternehmen');
  });
});

describe('Logo-Erkennung', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
  it('erkennt PNG und JPEG an den ersten Bytes, sonst nichts', () => {
    expect(sniffLogo(png)).toBe('image/png');
    expect(sniffLogo(jpeg)).toBe('image/jpeg');
    expect(sniffLogo(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffLogo(Buffer.alloc(0))).toBeNull();
  });
  it('LogoInvalidError trägt den Grund', () => {
    expect(new LogoInvalidError('too_large').getStatus()).toBe(413);
    expect(new LogoInvalidError('type').getStatus()).toBe(415);
  });
});
