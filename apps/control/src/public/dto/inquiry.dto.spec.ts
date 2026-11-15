import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PublicInquiryDto } from './inquiry.dto';

function check(raw: Record<string, unknown>) {
  const dto = plainToInstance(PublicInquiryDto, raw);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('OeffentlicheAnfrageDto', () => {
  it('nimmt eine Demo-Anfrage mit nur einer Adresse an', () => {
    expect(check({ inquiryKind: 'demo', email: 'gast@example.com' })).toHaveLength(
      0,
    );
  });

  it('verlangt bei einer PILOT-Anfrage Organisation und Ansprechperson', () => {
    const error = check({ inquiryKind: 'pilot', email: 'alex@example.com' });
    const fields = error.map((f) => f.property);
    expect(fields).toContain('company');
    expect(fields).toContain('name');
  });

  it('prüft ein freiwilliges Feld trotzdem, wenn es mitgeschickt wird', () => {
    // Sonst käme über eine Demo-Anfrage beliebiger Inhalt in `name` herein.
    const error = check({
      inquiryKind: 'demo',
      email: 'gast@example.com',
      name: 'x'.repeat(200),
    });
    expect(error.map((f) => f.property)).toContain('name');
  });

  it('kennt nur „demo" und „pilot"', () => {
    expect(
      check({ inquiryKind: 'sonstiges', email: 'gast@example.com' }),
    ).not.toHaveLength(0);
  });

  it('nimmt genau die Felder an, die die Webseite heute schickt', () => {
    expect(
      check({
        inquiryKind: 'pilot',
        company: 'Solawi Beispiel',
        name: 'Alex',
        email: 'alex@example.com',
        kind: 'Solawi',
        size: '30 Menschen',
        message: 'Interesse',
        website: '',
        terms: true,
        termsWording:
          'Ich habe die AGB gelesen und stimme ihnen zu. Wir fragen als Organisation an, nicht als Privatperson.',
        termsVersion: '12.09.2026',
      }),
    ).toHaveLength(0);
  });

  describe('AGB-Zustimmung', () => {
    const pilot = {
      inquiryKind: 'pilot',
      company: 'Solawi Beispiel',
      name: 'Alex',
      email: 'alex@example.com',
    };
    const fields = (raw: Record<string, unknown>) => check(raw).map((f) => f.property);

    it('ist bei einer PILOT-Anfrage Pflicht – serverseitig, nicht nur im Formular', () => {
      expect(fields(pilot)).toEqual(expect.arrayContaining(['terms', 'termsWording', 'termsVersion']));
    });

    it('verlangt ein echtes Ja: `false` reicht nicht', () => {
      expect(
        fields({
          ...pilot,
          terms: false,
          termsWording: 'Ich habe die AGB gelesen und stimme ihnen zu.',
          termsVersion: '12.09.2026',
        }),
      ).toContain('terms');
    });

    it('nimmt eine vollständige Zustimmung an', () => {
      expect(
        check({
          ...pilot,
          terms: true,
          termsWording: 'Ich habe die AGB gelesen und stimme ihnen zu.',
          termsVersion: '12.09.2026',
        }),
      ).toHaveLength(0);
    });

    it('weist einen Stand ab, der kein Datum ist', () => {
      expect(
        fields({
          ...pilot,
          terms: true,
          termsWording: 'Ich habe die AGB gelesen und stimme ihnen zu.',
          termsVersion: 'neueste',
        }),
      ).toContain('termsVersion');
    });

    it('verlangt sie bei einer DEMO-Anfrage nicht', () => {
      expect(check({ inquiryKind: 'demo', email: 'gast@example.com' })).toHaveLength(0);
    });
  });

  it('weist eine unvollständige Adresse ab', () => {
    expect(check({ inquiryKind: 'demo', email: 'gast@' })).not.toHaveLength(0);
  });
});
