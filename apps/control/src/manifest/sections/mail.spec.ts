import { MAIL_PRESET, checkMail } from './mail';

describe('Manifest-Abschnitt mail', () => {
  it('ist ohne Eintrag neutral', () => {
    const f: string[] = [];
    expect(checkMail(undefined, f)).toEqual(MAIL_PRESET);
    expect(f).toEqual([]);
    expect(MAIL_PRESET.legalLinks).toEqual([]);
    expect(MAIL_PRESET.domain).toBeNull();
  });

  it('liest Domäne, Antwortadresse, Webseite, Verweise und Anfrageziel', () => {
    const f: string[] = [];
    const m = checkMail(
      {
        domain: 'Example.COM',
        replyTo: 'hallo@example.com',
        websiteUrl: 'https://example.com',
        legalLinks: [{ text: 'Impressum', url: 'https://example.com/impressum' }],
        inquiryTo: 'kontakt@example.com',
      },
      f,
    );
    expect(f).toEqual([]);
    expect(m.domain).toBe('example.com');
    expect(m.replyTo).toBe('hallo@example.com');
    expect(m.legalLinks).toEqual([{ text: 'Impressum', url: 'https://example.com/impressum' }]);
    expect(m.inquiryTo).toBe('kontakt@example.com');
  });

  it('meldet ungültige Werte mit Pfad', () => {
    const f: string[] = [];
    checkMail(
      {
        domain: 'keine domain',
        replyTo: 'x',
        websiteUrl: 'http://unsicher.example',
        legalLinks: [{ text: 'A', url: 'ftp://x' }, 5],
        inquiryTo: 'y',
      },
      f,
    );
    const text = f.join('\n');
    for (const path of ['mail.domain', 'mail.replyTo', 'mail.websiteUrl', 'mail.legalLinks[0]', 'mail.legalLinks[1]', 'mail.inquiryTo']) {
      expect(text).toContain(path);
    }
  });
});
