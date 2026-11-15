import { ConfigService } from '@nestjs/config';
import { CODE_MAX_FAILED_ATTEMPTS } from '../auth/email-login-code.service';
import {
  RECIPIENT_RELATED_CLASSES,
  isRecipientRelated,
  classify,
  MailService,
} from './mail.service';

/**
 * [K2]: Aus dem Server darf nur eine FEHLERKLASSE herausgehen, niemals der
 * Wortlaut des Relays. Eine Empfängerabsage enthält die Zustelladresse des
 * zweiten Faktors im Klartext.
 */
describe('Klassifizierung von Versandfehlern', () => {
  it('erkennt eine abgewiesene Empfaengeradresse', () => {
    const raw =
      "Can't send mail - all recipients were rejected: 550 5.1.1 " +
      '<geheime.chefin@example.com> Recipient not found';
    expect(
      classify(
        { code: 'EENVELOPE', command: 'RCPT TO', rejected: ['x@y.example.com'] },
        raw,
      ),
    ).toBe('empfaenger_abgewiesen');
  });

  /**
   * ====================================================================
   * REGRESSIONSTEST ZU [A.30] — gemessen, nicht ausgedacht
   * ====================================================================
   *
   * Genau diese drei Felder lieferte nodemailer am 07.09.2026 gegen
   * einem Postausgang mit Absenderbindung, als der Envelope-From auf ein Postfach zeigte,
   * das dem angemeldeten Konto nicht gehört. `command` sagte `RCPT TO`,
   * gesprochen hat der Server über UNSEREN Absender.
   *
   * Vor dem Fix wurde daraus `empfaenger_abgewiesen` — die einzige Klasse,
   * die gegen die Empfängeradresse zählt. Drei Rundmails später hätte die
   * Warteschlange den gesamten Verteiler stillgelegt, ohne dass ein einziger
   * Empfänger je abgelehnt worden wäre.
   */
  it('erkennt eine ABSENDERabsage, auch wenn nodemailer `RCPT TO` meldet', () => {
    const raw =
      "Can't send mail - all recipients were rejected: 553 5.7.1 " +
      '<bounce@example.com>: Sender address rejected: not owned by user ' +
      'noreply@example.com';
    const errorClass = classify(
      { code: 'EENVELOPE', command: 'RCPT TO', rejected: ['hallo@example.com'] },
      raw,
    );
    expect(errorClass).toBe('absender_abgewiesen');
    // Und damit zählt sie NICHT gegen die Adresse der Empfängerin.
    expect(isRecipientRelated(errorClass)).toBe(false);
  });

  it('erkennt die übrigen Formulierungen der Absenderbindung', () => {
    for (const satz of [
      '553 Sender not allowed',
      '550 sender verify failed',
      '553 Sender address is not allowed for this account',
      '550 From does not match authenticated user',
    ]) {
      expect(
        classify({ code: 'EENVELOPE', command: 'RCPT TO' }, satz),
      ).toBe('absender_abgewiesen');
    }
  });

  /**
   * Der Meldungstext darf NUR in eine Richtung wirken. Eine echte
   * Empfängerabsage bleibt eine Empfängerabsage — sonst wäre aus der
   * Vorsichtsregel eine zweite Ratestelle geworden.
   */
  it('macht aus einer echten Empfängerabsage keine Absenderabsage', () => {
    expect(
      classify(
        { code: 'EENVELOPE', command: 'RCPT TO' },
        '550 5.1.1 <wer@example.com>: Recipient address rejected: User unknown',
      ),
    ).toBe('empfaenger_abgewiesen');
  });

  it('erkennt sie auch am Feld `recipient` allein', () => {
    expect(
      classify(
        { code: 'EENVELOPE', recipient: 'x@y.example.com' },
        'Recipient command failed: 550 no such user',
      ),
    ).toBe('empfaenger_abgewiesen');
  });

  it('gibt die Adresse aus der Rohmeldung NICHT weiter', () => {
    const raw = '550 <geheime.chefin@example.com> rejected';
    const errorClass = classify(
      { code: 'EENVELOPE', command: 'RCPT TO' },
      raw,
    );
    expect(errorClass).not.toContain('@');
    expect(errorClass).not.toContain('geheime');
    // Die Klasse ist ein fester Bezeichner, kein Freitext.
    expect([
      'verbindung',
      'tls',
      'login',
      'absender_abgewiesen',
      'empfaenger_abgewiesen',
      'unknown',
    ]).toContain(errorClass);
  });

  it('erkennt fehlende Transportverschluesselung', () => {
    expect(
      classify(
        {},
        'Error upgrading connection with STARTTLS: 502 5.5.1 Command not implemented',
      ),
    ).toBe('tls');
  });

  it('erkennt eine fehlgeschlagene SMTP-Anmeldung', () => {
    expect(classify({ code: 'EAUTH' }, 'Invalid login: 535 auth failed')).toBe(
      'login',
    );
  });

  it('erkennt einen nicht erreichbaren Postausgang', () => {
    expect(classify({ code: 'ESOCKET' }, 'connect ECONNREFUSED')).toBe(
      'verbindung',
    );
    expect(classify({}, 'Greeting never received')).toBe('verbindung');
  });

  it('faellt auf „unbekannt" zurueck statt etwas zu erfinden', () => {
    expect(classify({}, 'irgendwas ganz anderes')).toBe('unknown');
  });
});

/**
 * ===========================================================================
 * [K1] — DIE EINTEILUNG ENTSCHEIDET ÜBER EINEN UNUMKEHRBAREN VORGANG
 * ===========================================================================
 *
 * Drei Fehlschläge in Folge legen eine Adresse still, und aus
 * `hart_abgewiesen` gibt es keinen Weg zurück. Jeder Test hier fällt gegen die
 * alte Fassung, in der `unbekannt` zugleich Auffangwert und empfängerbezogen
 * war.
 */
describe('[K1] Fehler des eigenen Postausgangs bleiben auf unserer Seite', () => {
  /**
   * DER GEMESSENE FALL: ein Postausgang, dessen Name nicht auflöst. nodemailer
   * meldet `EDNS`; der alte Klassifizierer kannte den Code nicht und gab
   * `unbekannt` zurück — was damals gegen die Adresse zählte. Drei
   * Aussendungen während eines DNS-Ausfalls hätten den Verteiler gelöscht.
   */
  it('erkennt eine gescheiterte Namensauflösung als Verbindungsfehler', () => {
    expect(
      classify(
        { code: 'EDNS', command: 'CONN' },
        'getaddrinfo ENOTFOUND kein-solcher-postausgang.invalid',
      ),
    ).toBe('verbindung');
    expect(
      classify({}, 'getaddrinfo EAI_AGAIN smtp.example.com'),
    ).toBe('verbindung');
  });

  /**
   * nodemailer benutzt für Absender- UND Empfängerabsage denselben Code
   * `EENVELOPE`. Unterscheidbar sind sie nur über `command`. Vorher galt beides
   * als Empfängerabsage — ein falsch gesetzter Envelope-From hätte nach drei
   * Rundmails den gesamten Verteiler stillgelegt.
   */
  it('unterscheidet eine abgewiesene ABSENDERadresse von einer Empfängerabsage', () => {
    expect(
      classify(
        { code: 'EENVELOPE', command: 'MAIL FROM' },
        'Mail command failed: 550 5.7.1 Sender address rejected',
      ),
    ).toBe('absender_abgewiesen');
    expect(isRecipientRelated('absender_abgewiesen')).toBe(false);
  });

  it('wertet einen von nodemailer selbst verworfenen Umschlag nicht als Empfängerabsage', () => {
    // `command: 'API'` heisst: nodemailer hat gar nicht erst gefragt. Über den
    // Empfänger sagt das nichts.
    expect(
      classify(
        { code: 'EENVELOPE', command: 'API' },
        'No recipients defined',
      ),
    ).toBe('unknown');
  });

  it('lässt NUR die nachgewiesene Empfängerabsage gegen die Adresse zählen', () => {
    expect([...RECIPIENT_RELATED_CLASSES]).toEqual(['empfaenger_abgewiesen']);
    for (const errorClass of [
      'verbindung',
      'tls',
      'login',
      'absender_abgewiesen',
      'unknown',
      'abgebrochen',
      null,
      undefined,
    ]) {
      expect(isRecipientRelated(errorClass)).toBe(false);
    }
    expect(isRecipientRelated('empfaenger_abgewiesen')).toBe(true);
  });
});

/**
 * [W7]: Die Mail, die den zweiten Faktor trägt, darf keine falsche Zahl nennen.
 * Vorher stand „Nach fünf Fehleingaben" fest im Text, während der Code seit der
 * [W1]-Korrektur nach drei verfällt.
 */
describe('Der Mailtext nennt die geltende Zahl', () => {
  it('interpoliert CODE_MAX_FEHLVERSUCHE statt sie hinzuschreiben', async () => {
    const sent: { text?: string }[] = [];
    const config = {
      get: (key: string, defaultValue?: string) =>
        key === 'SMTP_HOST' ? undefined : defaultValue,
    } as unknown as ConfigService;
    const mail = new MailService(config);
    // jsonTransport: der echte Pfad, nur ohne Netz. Der Text kommt aus
    // nodemailers Ergebnis zurück.
    const original = (mail as unknown as {
      send: (...args: unknown[]) => Promise<void>;
    }).send.bind(mail);
    (mail as unknown as Record<string, unknown>)['send'] = async (
      _email: string,
      _subject: string,
      text: string,
      kind: string,
    ) => {
      sent.push({ text });
      return original(_email, _subject, text, kind);
    };

    await mail.sendLoginCode('ziel@example.com', '12345678', 10, false);

    const text = sent[0]?.text ?? '';
    expect(text).toContain(`Nach ${CODE_MAX_FAILED_ATTEMPTS} Fehleingaben`);
    expect(text).not.toContain('Nach fünf Fehleingaben');
    // Und die Zahl stimmt mit der Regel überein, die der Server durchsetzt.
    expect(CODE_MAX_FAILED_ATTEMPTS).toBe(3);
  });
});
