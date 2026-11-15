import type { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { houseLinks } from './layout/provider';
import { setTestBrand } from './layout/test-brand';
import { textFrom } from './layout';

/** Alle absoluten Adressen aus einem Dokument, ohne Dubletten. */
function addressesFrom(html: string): string[] {
  return [...new Set(html.match(/https?:\/\/[^"'\s<]+/g) ?? [])];
}
import {
  MailService,
  PREHEADER_LOGIN_CODE,
  PREHEADER_DEMO,
} from './mail.service';

beforeAll(() => setTestBrand());

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const createTransport = nodemailer.createTransport as unknown as jest.Mock;

const CONFIG: Record<string, string> = {
  SMTP_HOST: 'mailpit',
  SMTP_PORT: '1025',
  SMTP_TLS_ERZWINGEN: '0',
  DEMO_URL: 'https://demo.example.com',
  DEMO_LOGIN_USER: 'demo-nutzer',
  DEMO_LOGIN_PASS: 'streng-geheim-1234',
};

function service(): MailService {
  return new MailService({
    get: (name: string, defaultValue?: string) => CONFIG[name] ?? defaultValue,
  } as unknown as ConfigService);
}

/** Der unsichtbare Vorschautext aus dem erzeugten Dokument. */
function preheaderFrom(html: string): string {
  return /opacity:0;[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
}

describe('Jede Transaktionsmail geht mit beiden Teilen hinaus', () => {
  let mailbox: Record<string, unknown>[];

  beforeEach(() => {
    mailbox = [];
    createTransport.mockReturnValue({
      sendMail: async (message: Record<string, unknown>) => {
        mailbox.push(message);
        return {};
      },
    });
  });

  it('schickt Text UND HTML — nie nur eines von beidem', async () => {
    await service().sendLoginCode('anna@example.com', '12345678', 10, false);
    const mail = mailbox[0]!;
    expect(String(mail['text'])).toContain('12345678');
    expect(String(mail['html'])).toContain('<!doctype html>');
    expect(String(mail['html'])).toContain('12345678');
  });

  it('sagt in beiden Teilen dasselbe', async () => {
    await service().sendLoginCode('anna@example.com', '12345678', 10, false);
    const mail = mailbox[0]!;
    const fromHtml = textFrom(String(mail['html']));
    for (const satz of [
      'für die Anmeldung in der Beispielprodukt-Verwaltung wurde ein Code angefordert',
      '12345678',
      'Ohne dein Passwort nützt dieser Code niemandem',
    ]) {
      expect(String(mail['text'])).toContain(satz);
      expect(fromHtml).toContain(satz);
    }
  });

  it('trägt KEINEN Abmeldelink und keine Abmeldekopfzeile', async () => {
    await service().sendLoginCode('anna@example.com', '12345678', 10, false);
    const mail = mailbox[0]!;
    expect(String(mail['html']).toLowerCase()).not.toContain('abmelde');
    expect(String(mail['text']).toLowerCase()).not.toContain('abmelde');
    expect(mail['headers']).toBeUndefined();
  });

  /**
   * =======================================================================
   * DIESER TEST WAR NUR ZUFAELLIG GRUEN [A.33]
   * =======================================================================
   *
   * Hier stand `not.toMatch(/https?:\/\//)` auf dem HTML jeder
   * Transaktionsmail — und der Test lief auf `sendeAnmeldecode`, deren
   * Wortlaut zufaellig keine Adresse enthaelt. `sendeDemoZugang` und
   * `sendeEinwilligungsBestaetigung` tragen laengst welche im Rumpf; die
   * Zusicherung hat diese Faelle nie erfasst und haette sie auch gar nicht
   * halten koennen.
   *
   * Ersetzt durch eine Mengengleichheit je Mailart. Das ist erstmals eine
   * echte Aussage: Die Bestaetigungsmail traegt GENAU ihren eigenen Link und
   * die vier des Hauses — kein fünfter, keine Umleitung, keine Messstelle.
   */
  it('trägt genau die Adressen, die sie tragen soll', async () => {
    await service().sendLoginCode('anna@example.com', '12345678', 10, false);
    const onlyLayout = addressesFrom(String(mailbox[0]!['html']));
    expect(onlyLayout.sort()).toEqual(houseLinks().map((l) => l.url).sort());

    mailbox.length = 0;
    const link = 'https://verwaltung.example/api/consent/confirmation/abc';
    await service().sendConsentConfirmation('anna@example.com', link, 72);
    const withLink = addressesFrom(String(mailbox[0]!['html']));
    expect(withLink.sort()).toEqual(
      [link, ...houseLinks().map((l) => l.url)].sort(),
    );
  });

  it('rahmt auch die Bestätigungsmail des Double-Opt-in', async () => {
    // Sie geht VOR jeder Einwilligung hinaus. Ein Abmeldelink darunter wäre
    // sachlich falsch — es gibt nichts, wovon man sich abmelden könnte.
    await service().sendConsentConfirmation(
      'anna@example.com',
      'https://verwaltung.example/api/consent/confirmation/xyz',
      72,
    );
    const mail = mailbox[0]!;
    expect(String(mail['html'])).toContain('<!doctype html>');
    expect(String(mail['html']).toLowerCase()).not.toContain('abmelde');
    expect(mail['headers']).toBeUndefined();
  });

  it('rahmt auch eine Mail mit Anhang und lässt den Anhang unangetastet', async () => {
    await service().sendInvoice(
      'anna@example.com',
      'Rechnung 2026-0001',
      'Hallo,\n\nanbei die Rechnung.',
      { filename: 'r.pdf', content: Buffer.from('%PDF-1.7') },
    );
    const mail = mailbox[0]!;
    expect(String(mail['html'])).toContain('<!doctype html>');
    expect(String(mail['text'])).toContain('anbei die Rechnung.');
    const attachments = mail['attachments'] as { filename: string }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe('r.pdf');
  });
});

/**
 * ===========================================================================
 * DER VORSCHAUTEXT DARF KEIN GEHEIMNIS VERRATEN
 * ===========================================================================
 *
 * GEMESSEN, nicht vermutet: Die erste Fassung des Rahmens leitete den
 * Vorschautext aus den ersten ~90 Zeichen des Wortlauts ab. In Mailpit stand
 * daraufhin im Vorschaufeld der Anmeldecode-Mail:
 *
 *   „Hallo, für die Anmeldung in der Beispielprodukt-Verwaltung wurde ein Code
 *    angefordert: 12345678…"
 *
 * Genau diese Zeile zeigt ein Telefon auf dem SPERRBILDSCHIRM. Der zweite
 * Faktor wäre damit für jeden lesbar, der das Gerät in die Hand nimmt, ohne es
 * zu entsperren — und das Passwort allein nützte einem Angreifer dann.
 */
describe('Der Vorschautext verrät weder Code noch Passwort', () => {
  let mailbox: Record<string, unknown>[];

  beforeEach(() => {
    mailbox = [];
    createTransport.mockReturnValue({
      sendMail: async (message: Record<string, unknown>) => {
        mailbox.push(message);
        return {};
      },
    });
  });

  it('nennt bei der Anmeldecode-Mail den Code nicht', async () => {
    await service().sendLoginCode('anna@example.com', '12345678', 10, false);
    const preview = preheaderFrom(String(mailbox[0]!['html']));
    expect(preview).toBe(PREHEADER_LOGIN_CODE);
    expect(preview).not.toContain('12345678');
    // Und auch die Adresse nicht — sie steht in der Empfängerzeile, sonst
    // nirgends.
    expect(preview).not.toContain('anna@example.com');
  });

  it('nennt bei der Einrichtungsmail den Code ebenfalls nicht', async () => {
    await service().sendLoginCode('anna@example.com', '87654321', 10, true);
    expect(preheaderFrom(String(mailbox[0]!['html']))).not.toContain('87654321');
  });

  it('nennt bei der Demo-Mail das Passwort nicht', async () => {
    await service().sendDemoAccess('anna@example.com');
    const preview = preheaderFrom(String(mailbox[0]!['html']));
    expect(preview).toBe(PREHEADER_DEMO);
    expect(preview).not.toContain(CONFIG['DEMO_LOGIN_PASS']!);
    expect(preview).not.toContain(CONFIG['DEMO_LOGIN_USER']!);
  });

  it('leitet ihn bei Mails ohne Geheimnis weiterhin aus dem Text ab', async () => {
    // Der abgeleitete Vorschautext ist der Normalfall und soll es bleiben:
    // ohne ihn zeigten alle Mails in der Postfachliste dasselbe Wort.
    await service().sendInquiryNotification(
      'betreiberin@example.com',
      'Neue Pilotanfrage',
      ['Es ist eine neue Anfrage eingegangen.', 'Name: Beispielverein'],
    );
    const preview = preheaderFrom(String(mailbox[0]!['html']));
    expect(preview).toContain('Es ist eine neue Anfrage eingegangen.');
  });
});
