import { ConfigService } from '@nestjs/config';
import {
  REQUEST_MIN_DURATION_MS,
} from './login.service';
import { MailService } from '../mail/mail.service';
import { buildLogin } from '../test-support/login-provisioning';

/**
 * AK38 — die anonyme Anforderungsroute darf über die ANTWORTZEIT nicht
 * verraten, ob es die Kennung gibt.
 *
 * Der vorige Test hier prüfte einseitig (`unbekannt > bekannt/4`) und lief
 * gegen eine sofort zurückkehrende Mail-Attrappe. Er konnte den gemessenen
 * Faktor 3,0 strukturell nicht sehen ([W5]). Dieser hier misst wie der Prüfer:
 * mehrere Wiederholungen, Rohwerte im Fehlerfall, und eine ZWEISEITIGE
 * Schranke — zu schnell ist genauso verräterisch wie zu langsam.
 *
 * Entscheidend ist die künstlich langsame Mail-Attrappe: sie stellt genau den
 * SMTP-Roundtrip nach, der den 87-ms-Kanal verursacht hat. Wartet die Route
 * den Versand wieder ab, schlägt dieser Test fehl.
 */

jest.setTimeout(120_000);

const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest' };
/** So lange „braucht" der Postausgang. Deutlich über der Mindestdauer. */
const SEND_DURATION_MS = 400;
const REPETITIONS = 5;

/** Misst eine Anforderung; gibt die Dauer in Millisekunden zurück. */
async function miss(work: () => Promise<void>): Promise<number> {
  const start = process.hrtime.bigint();
  await work();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function raw(values: number[]): string {
  return values.map((w) => w.toFixed(1)).join(' / ');
}

describe('[K2] Die Anforderungsroute hat keinen Zeitkanal', () => {
  it('misst alle vier Fälle gleich lang — auch bei zähem Postausgang', async () => {
    const provisioning = await buildLogin({ loginCodeEnabled: true });
    const withoutFactor = await buildLogin({ loginCodeEnabled: false });
    // Der SMTP-Roundtrip, der den Kanal aufgemacht hat.
    provisioning.setSendDuration(SEND_DURATION_MS);

    const cases: Record<string, number[]> = {
      'unbekannte Kennung': [],
      'Konto vorhanden, Faktor AUS': [],
      'Konto vorhanden, Faktor AN': [],
      'Konto vorhanden, Code <60 s alt': [],
    };

    for (let run = 0; run < REPETITIONS; run += 1) {
      cases['unbekannte Kennung'].push(
        await miss(() => provisioning.service.requestLoginCode('gibtesnicht', SOURCE)),
      );
      cases['Konto vorhanden, Faktor AUS'].push(
        await miss(() => withoutFactor.service.requestLoginCode('sam', SOURCE)),
      );

      // Frisches Konto je Runde, damit „Faktor AN" wirklich einen Code erzeugt.
      const fresh = await buildLogin({ loginCodeEnabled: true });
      fresh.setSendDuration(SEND_DURATION_MS);
      cases['Konto vorhanden, Faktor AN'].push(
        await miss(() => fresh.service.requestLoginCode('sam', SOURCE)),
      );
      // Unmittelbar danach: jetzt greift die 60-Sekunden-Sperre.
      cases['Konto vorhanden, Code <60 s alt'].push(
        await miss(() => fresh.service.requestLoginCode('sam', SOURCE)),
      );
    }

    const medians = Object.entries(cases).map(([name, values]) => ({
      name,
      median: median(values),
      raw: raw(values),
    }));
    const smallest = Math.min(...medians.map((e) => e.median));
    const largest = Math.max(...medians.map((e) => e.median));

    // Rohwerte IMMER ausgeben, nicht nur im Fehlerfall — so lässt sich der
    // Lauf ohne Nachmessen gegen den Bericht des Prüfers halten.
    process.stdout.write(
      '\n  Antwortzeiten der Anforderungsroute (Median, Rohwerte):\n' +
        medians
          .map((e) => `    ${e.name}: ${e.median.toFixed(1)} ms  (${e.raw})\n`)
          .join('') +
        `    Spreizung: Faktor ${(largest / smallest).toFixed(2)}\n`,
    );

    // ZWEISEITIG: kein Fall darf messbar schneller ODER langsamer sein.
    // Der Prüfer maß Faktor 3,0 und 4,5; 1,25 lässt Rauschen zu und schlägt
    // bei jedem echten Kanal an.
    expect(largest / smallest).toBeLessThan(1.25);

    // Und keiner darf unter die Mindestdauer rutschen — das war der
    // 6,5-ms-Schnellweg des `zu_frueh`-Zweigs.
    expect(smallest).toBeGreaterThanOrEqual(REQUEST_MIN_DURATION_MS * 0.95);

    // Der zähe Versand darf die Antwort NICHT verlängert haben. Wartet die
    // Route ihn wieder ab, schlägt genau diese Zeile fehl.
    expect(largest).toBeLessThan(SEND_DURATION_MS);
  });

  it('läuft über den ECHTEN Versandpfad, nicht nur über eine Attrappe', async () => {
    // Ohne SMTP_HOST benutzt MailService den jsonTransport von nodemailer —
    // derselbe Code, dieselbe Serialisierung, nur ohne Netz. Der vorige Test
    // sah diesen Pfad gar nicht.
    const config = {
      get: (key: string, preset?: string) =>
        key === 'SMTP_HOST' ? undefined : preset,
    } as unknown as ConfigService;
    const mail = new MailService(config);

    const duration = await miss(async () => {
      await mail.sendLoginCode('ziel@example.com', '12345678', 10, false);
    });

    expect(duration).toBeLessThan(1000);
    expect(mail.sendState().lastError).toBeNull();
    expect(mail.sendState().configured).toBe(false);
  });
});
