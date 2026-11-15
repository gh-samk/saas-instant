import type { ConfigService } from '@nestjs/config';
import {
  senderAddresses,
  addressFrom,
  domainFrom,
  checkSenderAlignment,
  registerMailManifest,
} from './sender';
import { MAIL_PRESET } from '../manifest/sections/mail';

afterEach(() => registerMailManifest(null));

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (name: string, defaultValue?: string) => values[name] ?? defaultValue,
  } as unknown as ConfigService;
}

describe('Absenderadressen', () => {
  it('schält die nackte Adresse aus einem Anzeigenamen', () => {
    expect(addressFrom('Beispielprodukt <news@example.com>')).toBe('news@example.com');
    expect(addressFrom('  News@Example.COM ')).toBe('news@example.com');
  });

  it('liest die Domäne', () => {
    expect(domainFrom('Beispielprodukt <news@example.com>')).toBe('example.com');
    expect(domainFrom('broken')).toBe('');
  });

  /**
   * ====================================================================
   * DER REGRESSIONSTEST ZU [A.30]
   * ====================================================================
   *
   * Die Vorgaben hiessen `rechnung@`, `news@`, `kontakt@` und `bounce@` —
   * vier Postfächer, die auf dem Postausgang nie angelegt worden waren.
   * Postfix wies daraufhin JEDE Mail ab:
   *
   *     553 5.7.1 <bounce@example.com>: Sender address rejected:
   *                                      not owned by user noreply@example.com
   *
   * Geprüft wird deshalb die REGEL, nicht die Adresse: Was ohne
   * ausdrückliche Konfiguration im Umschlag steht, muss das Konto sein,
   * mit dem sich der Postausgang anmeldet — die einzige Adresse, von der
   * feststeht, dass er sie annimmt.
   */
  it('erfindet ohne Konfiguration KEINE Postfächer, sondern nimmt SMTP_FROM', () => {
    const a = senderAddresses(
      config({ SMTP_FROM: 'Beispielprodukt Verwaltung <noreply@example.com>' }),
    );
    expect(a.returnPath).toBe('noreply@example.com');
    expect(addressFrom(a.invoice)).toBe('noreply@example.com');
    expect(addressFrom(a.broadcast)).toBe('noreply@example.com');
  });

  it('lässt die getrennten Adressen zu, sobald sie hinterlegt sind', () => {
    const a = senderAddresses(
      config({
        SMTP_FROM: 'Beispielprodukt Verwaltung <noreply@example.com>',
        MAIL_SENDER_INVOICE: 'Beispielprodukt Rechnungen <rechnung@example.com>',
        MAIL_SENDER_BROADCAST: 'Beispielprodukt <news@example.com>',
        MAIL_RETURN_PATH: 'bounce@example.com',
        MAIL_REPLY_TO: 'kontakt@example.com',
      }),
    );
    expect(addressFrom(a.invoice)).toBe('rechnung@example.com');
    expect(addressFrom(a.broadcast)).toBe('news@example.com');
    expect(a.returnPath).toBe('bounce@example.com');
    expect(addressFrom(a.replyTo)).toBe('kontakt@example.com');
  });

  /**
   * Die Antwortadresse prüft kein Postausgang — sie fällt erst auf, wenn
   * eine Antwort zurückkommt. Sie kommt aus dem Manifest (`mail.replyTo`);
   * ohne Eintrag ist es das Versandkonto, nie eine erfundene Adresse.
   */
  it('antwortet an `mail.replyTo` aus dem Manifest', () => {
    registerMailManifest({
      ...MAIL_PRESET,
      senderName: 'Beispielprodukt',
      senderAddress: 'noreply@example.com',
      replyTo: 'hallo@example.com',
    });
    const a = senderAddresses(config());
    expect(addressFrom(a.replyTo)).toBe('hallo@example.com');
    expect(addressFrom(a.replyTo)).not.toBe(addressFrom(a.admin));
  });

  it('erfindet ohne Eintrag keine Antwortadresse, sondern nimmt das Versandkonto', () => {
    const a = senderAddresses(
      config({ SMTP_FROM: 'Beispielprodukt Verwaltung <noreply@example.com>' }),
    );
    expect(addressFrom(a.replyTo)).toBe('noreply@example.com');
  });

  it('leitet Absender und Domäne aus dem Manifest ab, Umgebung hat Vorrang', () => {
    registerMailManifest({
      ...MAIL_PRESET,
      senderName: 'Beispielprodukt',
      senderAddress: 'versand@example.com',
    });
    const a = senderAddresses(config());
    expect(a.admin).toBe('Beispielprodukt <versand@example.com>');
    expect(a.domain).toBe('example.com');
    expect(a.returnPath).toBe('versand@example.com');
    expect(senderAddresses(config({ MAIL_DOMAIN: 'Andere.Example' })).domain).toBe(
      'andere.example',
    );
  });

  it('fällt ohne Umgebung und Manifest auf die Beispiel-Domäne zurück', () => {
    const a = senderAddresses(config());
    expect(a.domain).toBe('example.com');
    expect(a.admin).toBe('SAAS Verwaltung <noreply@example.com>');
  });

  /**
   * DER GEMESSENE ZUSTAND DER DOMÄNE: kein DKIM, DMARC auf p=quarantine mit
   * aspf=s. Damit steht und fällt die Zustellung mit der Ausrichtung des
   * Envelope-From. Ein Rückweg auf einer fremden Domäne bedeutet: Spam-Ordner.
   */
  it('hat einen Rückweg auf DERSELBEN Domäne wie der Absender', () => {
    const a = senderAddresses(config());
    expect(domainFrom(a.returnPath)).toBe(domainFrom(a.broadcast));
    expect(domainFrom(a.returnPath)).toBe(domainFrom(a.invoice));
  });

  /**
   * SMTP_FROM steht seit Etappe 1 in jeder Betriebsumgebung und lässt sich
   * frei setzen. Er MUSS mitgeprüft werden: Eine Verwaltungsadresse auf
   * fremder Domäne bricht die strenge Ausrichtung genauso wie ein falscher
   * Rückweg — und über sie gehen die Anmeldecodes.
   */
  it('prüft auch SMTP_FROM', () => {
    const addresses = senderAddresses(
      config({
        MAIL_DOMAIN: 'mail.example.com',
        SMTP_FROM: 'Beispielprodukt <noreply@example.com>',
      }),
    );
    expect(() => checkSenderAlignment('production', addresses)).toThrow(
      /SMTP_FROM/,
    );
  });

  it('lässt eine falsch ausgerichtete Absenderadresse in Produktion NICHT durch', () => {
    const addresses = senderAddresses(
      config({ MAIL_SENDER_BROADCAST: 'Beispielprodukt <news@mailer.example.com>' }),
    );
    expect(() => checkSenderAlignment('production', addresses)).toThrow(
      /MAIL_SENDER_BROADCAST/,
    );
  });

  it('lässt sie in der Entwicklung durch (Mailpit nimmt jede Adresse an)', () => {
    const addresses = senderAddresses(
      config({ MAIL_RETURN_PATH: 'irgendwer@localhost' }),
    );
    expect(() =>
      checkSenderAlignment('development', addresses),
    ).not.toThrow();
  });

  it('lässt eine frische Installation ohne eingerichtete Absender in Produktion starten', () => {
    const addresses = {
      domain: 'example.com',
      admin: '',
      invoice: '',
      broadcast: '',
      returnPath: '',
    } as ReturnType<typeof senderAddresses>;
    expect(() => checkSenderAlignment('production', addresses)).not.toThrow();
  });

  it('prüft eine einzelne gesetzte Adresse weiter streng, auch wenn die anderen leer sind', () => {
    const addresses = {
      domain: 'example.com',
      admin: '',
      invoice: 'R <rechnung@anderswo.example.net>',
      broadcast: '',
      returnPath: '',
    } as ReturnType<typeof senderAddresses>;
    expect(() => checkSenderAlignment('production', addresses)).toThrow(
      /MAIL_SENDER_INVOICE/,
    );
  });

  it('nimmt eine abweichende, aber einheitliche Domäne an', () => {
    const addresses = senderAddresses(
      config({
        MAIL_DOMAIN: 'example.com',
        SMTP_FROM: 'V <verwaltung@example.com>',
        MAIL_SENDER_INVOICE: 'R <rechnung@example.com>',
        MAIL_SENDER_BROADCAST: 'N <news@example.com>',
        MAIL_RETURN_PATH: 'bounce@example.com',
      }),
    );
    expect(() => checkSenderAlignment('production', addresses)).not.toThrow();
  });
});
