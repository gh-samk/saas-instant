import type { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MarketingApproval } from '../consent/consent.gate';
import type { DbClient } from '../prisma/db-client';
import { htmlFromText } from '../mail/layout';
import { setTestBrand } from '../mail/layout/test-brand';

beforeAll(() => setTestBrand());
import { MarketingMailError, MarketingMailService } from './marketing-mail.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const createTransport = nodemailer.createTransport as unknown as jest.Mock;

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (name: string, defaultValue?: string) => values[name] ?? defaultValue,
  } as unknown as ConfigService;
}

/** Ein Datenbank-Doppel, das genau eine Einwilligungszeile kennt. */
function db(row: Record<string, unknown> | null): DbClient {
  return {
    $queryRaw: async () => [],
    consent: { findUnique: async () => row },
  } as unknown as DbClient;
}

const CONFIRMED = {
  id: 'e-1',
  email: 'anna@example.com',
  status: 'confirmed',
  unsubscribeToken: 'token-abc',
  companyId: null,
};

const UNSUBSCRIBE_LINK = 'https://verwaltung.example/api/consent/unsubscribe/token-abc';

async function approval(): Promise<MarketingApproval> {
  const check = await MarketingApproval.check(db(CONFIRMED), 'e-1');
  if (!check.granted) throw new Error('Freigabe erwartet.');
  return check.approval;
}

function buildService(values: Record<string, string> = {}): MarketingMailService {
  const konf = config({ SMTP_HOST: 'localhost', SMTP_PORT: '1025', ...values });
  return new MarketingMailService(konf);
}

/**
 * Baut die fertige Mail aus einem reinen Textrumpf.
 *
 * Seit dem Mailrahmen hat jede Mail zwei Teile; `wortlaut` verlangt beide
 * Fassungen des Rumpfs. `htmlAusText` erzeugt die HTML-Fassung genauso, wie
 * es der Versandweg für Vorlagen ohne Redaktionsfeld tut.
 */
function mailFrom(
  service: MarketingMailService,
  body: string,
  subject = 'Betreff',
) {
  return service.wording(
    { subject, html: htmlFromText(body), text: body },
    UNSUBSCRIBE_LINK,
  );
}

describe('Das Tor entscheidet, wer eine werbliche Mail bekommen kann', () => {
  it('erteilt eine Freigabe nur bei bestätigtem Opt-in', async () => {
    await expect(MarketingApproval.check(db(CONFIRMED), 'e-1')).resolves.toEqual(
      expect.objectContaining({ granted: true }),
    );
  });

  it.each([
    ['unconfirmed', 'nicht_bestaetigt'],
    ['unsubscribed', 'unsubscribed'],
    ['hard_bounced', 'hard_bounced'],
    ['spam_reported', 'spam_reported'],
  ])('verweigert sie bei Status %s', async (status, reason) => {
    const check = await MarketingApproval.check(
      db({ ...CONFIRMED, status }),
      'e-1',
    );
    expect(check).toEqual({ granted: false, reason });
  });

  it('verweigert sie, wenn es die Adresse gar nicht gibt', async () => {
    expect(await MarketingApproval.check(db(null), 'e-1')).toEqual({
      granted: false,
      reason: 'kein_eintrag',
    });
  });

  /**
   * Eine werbliche Mail ohne Abmeldemöglichkeit ist auch mit Einwilligung
   * unzulässig. Ohne Token liesse sich kein personalisierter Abmeldelink
   * bauen — also geht nichts hinaus.
   */
  it('verweigert sie ohne Abmeldetoken', async () => {
    const check = await MarketingApproval.check(
      db({ ...CONFIRMED, unsubscribeToken: null }),
      'e-1',
    );
    expect(check).toEqual({ granted: false, reason: 'kein_abmeldetoken' });
  });
});

describe('Der werbliche Kanal', () => {
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    sent = [];
    createTransport.mockReturnValue({
      sendMail: async (message: Record<string, unknown>) => {
        sent.push(message);
        return {};
      },
    });
  });

  it('schickt an GENAU EINE Adresse und setzt niemals bcc oder cc', async () => {
    const service = buildService();
    const free = await approval();
    await service.send(
      free,
      'Neues aus Beispielprodukt',
      mailFrom(service, 'Hallo euch,\n\nes gibt Neues.'),
      UNSUBSCRIBE_LINK,
    );

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail['to']).toBe('anna@example.com');
    expect(mail['bcc']).toBeUndefined();
    expect(mail['cc']).toBeUndefined();
    const envelope = mail['envelope'] as { to: string[] };
    expect(envelope.to).toEqual(['anna@example.com']);
  });

  it('setzt den Rückweg auf die Absenderdomäne (DMARC, aspf=s)', async () => {
    // Mit hinterlegten Adressen: die getrennte Rundmail-Identität steht,
    // und der Rückweg liegt trotzdem auf derselben Domäne.
    const service = buildService({
      MAIL_SENDER_BROADCAST: 'Beispielprodukt <news@example.com>',
      MAIL_RETURN_PATH: 'bounce@example.com',
      MAIL_REPLY_TO: 'kontakt@example.com',
    });
    const free = await approval();
    await service.send(
      free,
      'Betreff',
      mailFrom(service, 'Text'),
      UNSUBSCRIBE_LINK,
    );
    const mail = sent[0]!;
    const envelope = mail['envelope'] as { from: string };
    expect(envelope.from).toBe('bounce@example.com');
    expect(String(mail['from'])).toContain('news@example.com');
    expect(mail['replyTo']).toBe('kontakt@example.com');
  });

  /**
   * OHNE hinterlegte Adressen darf der werbliche Kanal keine Postfächer
   * erfinden ([A.30]). `news@` und `bounce@` gab es auf dem Postausgang
   * nicht, und Postfix wies daraufhin jede Rundmail schon beim `MAIL FROM`
   * ab — sichtbar wurde davon nichts.
   */
  it('nimmt ohne eigene Rundmail-Adresse das Versandkonto', async () => {
    const service = buildService({
      SMTP_FROM: 'Beispielprodukt Verwaltung <noreply@example.com>',
    });
    const free = await approval();
    await service.send(
      free,
      'Betreff',
      mailFrom(service, 'Text'),
      UNSUBSCRIBE_LINK,
    );
    const mail = sent[0]!;
    const envelope = mail['envelope'] as { from: string };
    expect(envelope.from).toBe('noreply@example.com');
    expect(String(mail['from'])).toContain('noreply@example.com');
  });

  it('setzt beide Kopfzeilen der Ein-Klick-Abmeldung (RFC 8058)', async () => {
    const service = buildService();
    const free = await approval();
    await service.send(
      free,
      'Betreff',
      mailFrom(service, 'Text'),
      UNSUBSCRIBE_LINK,
    );
    const header = sent[0]!['headers'] as Record<string, string>;
    expect(header['List-Unsubscribe']).toBe(`<${UNSUBSCRIBE_LINK}>`);
    expect(header['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  /**
   * Die Fusszeile wird ANGEHÄNGT und nicht aus der Vorlage genommen. Eine
   * Fusszeile, die im Redaktionsbereich steht, lässt sich löschen — und dann
   * geht eine werbliche Mail ohne Abmeldemöglichkeit und ohne Impressum
   * hinaus.
   */
  it('hängt Abmeldelink und Anbieterkennung selbst an', async () => {
    const service = buildService();
    const wording = mailFrom(service, 'Nur der Rumpf.');
    // BEIDE TEILE tragen beides. Ein HTML-Teil ohne Abmeldelink wäre
    // derselbe Verstoss — nur in der Fassung, die die meisten sehen.
    for (const part of [wording.text, wording.html]) {
      expect(part).toContain('Nur der Rumpf.');
      expect(part).toContain(UNSUBSCRIBE_LINK);
      expect(part).toContain('Amtsgericht Musterstadt');
      expect(part).toContain('USt-IdNr.');
    }
    expect(wording.text).toContain('Beispiel GmbH');
    // Im HTML mit escapetem kaufmännischem Und.
    expect(wording.html).toContain('Beispiel GmbH');
  });

  it('verschickt keinen Wortlaut, dem der Abmeldelink fehlt', async () => {
    const service = buildService();
    const free = await approval();
    await expect(
      service.send(
        free,
        'Betreff',
        { text: 'Text ohne Fusszeile', html: '<p>Text ohne Fusszeile</p>' },
        UNSUBSCRIBE_LINK,
      ),
    ).rejects.toMatchObject({ errorCode: 'werbemail_ohne_abmeldelink' });
    expect(sent).toHaveLength(0);
  });

  /**
   * DER FALL, DEN ES OHNE DEN RAHMEN NICHT GAB: Der Textteil trägt den
   * Abmeldelink, der HTML-Teil nicht. Wer nur den Text prüft, lässt eine Mail
   * hinaus, die für fast alle Empfängerinnen keine Abmeldemöglichkeit hat.
   */
  it('verschickt auch dann nicht, wenn NUR dem HTML-Teil der Link fehlt', async () => {
    const service = buildService();
    const free = await approval();
    const real = mailFrom(service, 'Nur der Rumpf.');
    await expect(
      service.send(
        free,
        'Betreff',
        { text: real.text, html: real.html.split(UNSUBSCRIBE_LINK).join('#') },
        UNSUBSCRIBE_LINK,
      ),
    ).rejects.toMatchObject({ errorCode: 'werbemail_ohne_abmeldelink' });
    expect(sent).toHaveLength(0);
  });

  it('verschickt beide Teile, nie nur einen', async () => {
    const service = buildService();
    const free = await approval();
    await service.send(free, 'B', mailFrom(service, 'Text'), UNSUBSCRIBE_LINK);
    const mail = sent[0]!;
    expect(String(mail['text'])).toContain('Text');
    expect(String(mail['html'])).toContain('<!doctype html>');
    expect(String(mail['html'])).toContain('Text');
  });

  it('reicht die Fehlerklasse nach oben, nicht den Wortlaut des Relays', async () => {
    createTransport.mockReturnValue({
      sendMail: async () => {
        const error = new Error(
          'Recipient command failed: 550 <geheim@kunde.example.com> rejected',
        );
        // [K1]: `command` unterscheidet die Empfängerabsage von einer
        // Absenderabsage. Ohne diese Angabe wäre es KEINE nachgewiesene
        // Empfängerabsage — und dürfte dann auch nicht gegen die Adresse
        // zählen.
        Object.assign(error, {
          code: 'EENVELOPE',
          command: 'RCPT TO',
          recipient: 'geheim@kunde.example.com',
        });
        throw error;
      },
    });
    const service = buildService();
    const free = await approval();
    const exception = await service
      .send(free, 'B', mailFrom(service, 'T'), UNSUBSCRIBE_LINK)
      .catch((f: unknown) => f);
    expect(exception).toBeInstanceOf(MarketingMailError);
    expect((exception as MarketingMailError).errorClass).toBe('empfaenger_abgewiesen');
    expect(JSON.stringify(exception)).not.toContain('geheim@kunde.example.com');
  });

  it('nimmt eine zusätzliche mailto-Abmeldung auf, wenn konfiguriert', async () => {
    const service = buildService({ MAIL_UNSUBSCRIBE_MAILTO: 'abmelden@example.com' });
    const free = await approval();
    await service.send(
      free,
      'B',
      mailFrom(service, 'T'),
      UNSUBSCRIBE_LINK,
    );
    const header = sent[0]!['headers'] as Record<string, string>;
    expect(header['List-Unsubscribe']).toBe(
      `<${UNSUBSCRIBE_LINK}>, <mailto:abmelden@example.com?subject=Abmeldung>`,
    );
  });
});
