import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

/** Stellen des Codes. Acht Ziffern = 100 Millionen Möglichkeiten. */
export const CODE_LENGTH = 8;
/** Gültigkeitsdauer eines Codes: 10 Minuten. */
export const CODE_VALID_MS = 10 * 60 * 1000;
/**
 * Nach so vielen Fehleingaben ist der Code verbrannt.
 *
 * MUSS ECHT KLEINER SEIN ALS `MAX_FEHLVERSUCHE` (Kontosperre, 5). Standen
 * beide auf 5, liefen die Zähler im Gleichschritt hoch, die Kontosperre griff
 * im selben Versuch und `KontoGesperrtFehler` verdrängte die Verbrannt-Meldung
 * — sie war im häufigsten Weg unerreichbar ([W1]).
 *
 * Fachlich ist die Reihenfolge auch die richtige: ein toter Code ist ein
 * harmloser Zustand mit klarem Ausweg („neuen anfordern"), eine Kontosperre
 * ist es nicht. Wer sich vertippt, soll zuerst den Code verlieren und erst bei
 * fortgesetztem Raten das Konto.
 */
export const CODE_MAX_FAILED_ATTEMPTS = 3;
/** Frühestens nach 60 Sekunden lässt sich ein neuer Code anfordern. */
export const CODE_AGAIN_BY_MS = 60 * 1000;

/**
 * Erzeugt einen achtstelligen Zahlen-Code.
 *
 * `randomInt` aus `node:crypto`, NICHT `Math.random`: Letzteres ist ein
 * vorhersagbarer Generator. Wer genug Ausgaben sieht, kann seinen Zustand
 * rekonstruieren und die nächsten Codes ausrechnen — bei einem Anmeldefaktor
 * wäre das ein vollständiger Bruch.
 *
 * Ziffernweise gezogen (statt `randomInt(0, 1e8)` und links auffüllen), damit
 * jede Stelle gleichverteilt ist und führende Nullen selbstverständlich
 * vorkommen.
 */
export function generateCode(): string {
  let code = '';
  for (let place = 0; place < CODE_LENGTH; place += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/**
 * Erkennt die Verletzung eines Eindeutigkeitsindex (Prisma `P2002`).
 *
 * Bewusst über die Fehlerkennung statt über `instanceof`: der Client wird nach
 * `.prisma/control-client` generiert, und ein `instanceof` gegen die
 * Fehlerklasse eines ANDEREN Generats wäre still falsch.
 */
function isUniquenessViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Bringt eine Eingabe auf die Normalform, gegen die gehasht wird: nur Ziffern.
 * So sind „1234 5678", „1234-5678" und „12345678" derselbe Code.
 */
export function normalizeDigitCode(input: string): string {
  return input.replace(/\D/g, '');
}

/** Ergebnis einer Code-Anforderung. */
export type RequestResult =
  | {
      kind: 'generated';
      /** Klartext — existiert NUR hier und in der E-Mail. */
      code: string;
      /** Id der geschriebenen Zeile — für ein gezieltes `verwirf`. */
      codeId: string;
      /**
       * Entstehungszeitpunkt GENAU DIESER Ausgabe.
       *
       * Zusammen mit `codeId` die Kennung des Codes. Die Id allein genügt
       * nicht: wegen `@@unique([benutzerId])` gibt es nur EINE Zeile je
       * Benutzer, ein späterer Code überschreibt sie und behält dieselbe Id.
       * Ein gescheiterter Versand würde sonst den Nachfolger löschen — genau
       * der Schaden aus [W2], nur eine Ebene tiefer.
       */
      createdAt: Date;
      expiresAt: Date;
    }
  | {
      kind: 'too_early';
      /** Restsekunden bis zur nächsten erlaubten Anforderung. */
      secondsRemaining: number;
    };

/** Ergebnis einer Code-Einlösung. */
export type RedeemResult =
  | { kind: 'ok'; codeId: string; targetEmail: string }
  | { kind: 'no_code' }
  | { kind: 'expired' }
  | { kind: 'wrong_purpose' }
  /** Der Code lebt noch, die Eingabe war falsch. */
  | { kind: 'wrong'; failedAttempts: number; burned: boolean }
  /**
   * Der Code ist durch zu viele Fehleingaben tot — und bleibt es sichtbar.
   * Vorher fiel jeder weitere Versuch auf `kein_code` und damit auf die
   * generische Meldung zurück; „verbrannt" war nur im Übergangsversuch zu
   * sehen ([H1]).
   */
  | { kind: 'burned' };

/**
 * Der Grund eines Fehlschlags, wie er nach AUSSEN gehen darf — genau drei
 * Werte, mehr nicht.
 *
 * Geht als `detail.grund` bei `anmeldung_fehlgeschlagen` mit, damit die
 * Oberfläche einen Tippfehler von einem verbrannten und einem abgelaufenen
 * Code unterscheiden kann.
 *
 * UNBEDENKLICH, weil sich der Aufrufer an beiden Stellen vorher ausgewiesen
 * hat: beim Anmelden durch das Passwort (das Cookie `anmeldung` entsteht
 * ausschließlich nach erfolgreicher Passwortprüfung), beim Einrichten durch
 * die Sitzung. Der Grund verrät nichts, was ein Angreifer an dieser Stelle
 * nicht ohnehin wüsste.
 *
 * GILT NICHT für `fordereAnmeldecodeAn`: diese Route ist anonym und antwortet
 * immer gleich. Dort geht nichts nach draußen — auch kein Grund.
 *
 * `fehlversuche` wird AUSDRÜCKLICH NICHT herausgereicht. Der Restzähler bleibt
 * draußen; das ist eine bewusste Festlegung des Frontend-Durchgangs, vom
 * Design-Tester bestätigt. Der Service kennt die Zahl (`EinloeseErgebnis`),
 * sie endet hier.
 */
export type RedeemReason = 'wrong' | 'burned' | 'expired';

/**
 * Sichtbare Meldung je Grund. Eine Stelle für Anmeldung UND Einrichtung, damit
 * die beiden Wege nicht auseinanderlaufen.
 */
export const MESSAGE_TO_REASON: Record<RedeemReason, string> = {
  wrong: 'Falscher Code. Bitte erneut versuchen.',
  burned:
    'Dieser Code wurde zu oft falsch eingegeben und gilt nicht mehr. Bitte einen neuen anfordern.',
  expired: 'Der Code ist abgelaufen. Bitte einen neuen anfordern.',
};

/** Meldung, wenn es gar keinen Code gibt, über den etwas zu sagen wäre. */
export const MESSAGE_WITHOUT_REASON = 'Falscher Code. Bitte erneut versuchen.';

/**
 * Bildet ein Einlöseergebnis auf den nach außen sichtbaren Grund ab.
 *
 * `null` heißt: es gibt keinen mitteilbaren Grund, der Fehler geht OHNE
 * `detail` hinaus. Das trifft `kein_code` (nie einer angefordert oder längst
 * weggeräumt) und `falscher_zweck` — dass ein Code für den ANDEREN Zweck
 * existiert, geht den Aufrufer nichts an.
 */
export function reasonOf(result: RedeemResult): RedeemReason | null {
  switch (result.kind) {
    case 'wrong':
      return result.burned ? 'burned' : 'wrong';
    case 'burned':
      return 'burned';
    case 'expired':
      return 'expired';
    default:
      return null;
  }
}

/** Auswahl für alle Code-Abfragen. Der Hash bleibt im Service. */
const CODE_SELECTION = {
  id: true,
  codeHash: true,
  targetEmail: true,
  forSetup: true,
  createdAt: true,
  expiresAt: true,
  failedAttempts: true,
  consumedAt: true,
} as const;

/**
 * Achtstellige Anmeldecodes per E-Mail — der dritte mögliche zweite Faktor
 * neben TOTP und Passkey.
 *
 * Absicherung gegen Erraten auf vier Ebenen, die sich nicht ersetzen:
 *
 * 1. **Kurze Gültigkeit** (10 Minuten) und **genau eine** Verwendung. Die
 *    Entwertung ist ein bedingtes `updateMany` und damit atomar — dasselbe
 *    Muster wie in `wiederherstellungscode.service.ts`.
 * 2. **`CODE_MAX_FEHLVERSUCHE` Fehlversuche je Code**, danach ist er verbrannt.
 *    Das begrenzt das Raten auf einen einzelnen Code, unabhängig von allem
 *    anderen. Die Zahl steht hier bewusst NICHT ausgeschrieben: sie stand
 *    einmal als „fünf" da und blieb stehen, als die Konstante auf 3 sank ([W9]).
 *    `mail.service.ts` interpoliert sie aus demselben Grund.
 * 3. **60 Sekunden Sperre vor der nächsten Anforderung**, damit sich Ebene 2
 *    nicht durch massenhaftes Neu-Anfordern umgehen lässt.
 * 4. Die **Kontosperre** (5 Versuche, 15 Minuten) über `SperreService` —
 *    verbucht der Aufrufer, nicht dieser Service.
 *
 * Der Klartext des Codes wird NIE gespeichert (argon2id) und steht in keinem
 * Log außer der Entwicklungs-Mailausgabe ohne SMTP.
 */
@Injectable()
export class EmailLoginCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Die Adresse, an die Codes gehen: die ausdrücklich hinterlegte, sonst die
   * Konto-E-Mail. So ist die Vorgabe automatisch richtig und bleibt es auch,
   * wenn `email` später wechselt.
   */
  targetAddress(account: { email: string; loginCodeEmail: string | null }): string {
    return account.loginCodeEmail ?? account.email;
  }

  /** Der aktuell hinterlegte Code des Kontos, oder null. */
  private async currentCode(userId: string) {
    // `@@unique([benutzerId])` garantiert höchstens eine Zeile — deshalb reicht
    // findFirst, und es gibt keine Sortierung mehr, die einen Altbestand
    // aussieben müsste.
    return this.prisma.emailLoginCode.findFirst({
      where: { userId },
      select: CODE_SELECTION,
    });
  }

  /**
   * Erzeugt einen neuen Code und überschreibt damit den vorherigen.
   *
   * DIE DATENBANK ENTSCHEIDET, nicht die Anwendung. Es wird nichts vorher
   * gelesen und danach geschrieben — das war der Fehler [W2], durch den fünf
   * gleichzeitige Anforderungen fünf Mails erzeugten (von denen vier schon tot
   * ankamen, weil jede die vorige entwertete).
   *
   * Zwei Anweisungen, beide für sich atomar:
   *
   * 1. `create` — gelingt nur, wenn es NOCH KEINE Zeile gibt. Bei
   *    gleichzeitigen Aufrufen gewinnt genau einer, alle anderen laufen in die
   *    Verletzung des Eindeutigkeitsindex (P2002) und fallen auf Schritt 2.
   * 2. `updateMany` mit der Bedingung „älter als 60 Sekunden ODER bereits
   *    verbraucht" — ein einzelnes bedingtes UPDATE. Postgres serialisiert
   *    UPDATEs auf dieselbe Zeile und wertet die Bedingung danach gegen den
   *    NEUEN Zeilenstand aus; der zweite gleichzeitige Aufruf sieht also
   *    bereits `erstelltAm = jetzt` und bekommt `count === 0`.
   *
   * Ein bereits VERBRAUCHTER Code blockiert bewusst nicht ([H2]): nach einer
   * erfolgreichen Anmeldung soll niemand bis zu 60 Sekunden warten müssen, ohne
   * dass ihm das jemand sagt. Ein VERBRANNTER Code (CODE_MAX_FEHLVERSUCHE
   * Fehleingaben) blockiert
   * dagegen weiter — er ist der Anker gegen das Weiterraten.
   */
  async request(
    userId: string,
    targetEmail: string,
    forSetup: boolean,
    now: Date = new Date(),
  ): Promise<RequestResult> {
    const code = generateCode();
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });
    const expiresAt = new Date(now.getTime() + CODE_VALID_MS);
    const fields = {
      codeHash,
      targetEmail,
      forSetup,
      createdAt: now,
      expiresAt,
      failedAttempts: 0,
      consumedAt: null,
    };

    try {
      const created = await this.prisma.emailLoginCode.create({
        data: { userId, ...fields },
        select: { id: true },
      });
      return {
        kind: 'generated',
        code,
        codeId: created.id,
        createdAt: now,
        expiresAt,
      };
    } catch (error) {
      if (!isUniquenessViolation(error)) throw error;
    }

    const limit = new Date(now.getTime() - CODE_AGAIN_BY_MS);
    const replaced = await this.prisma.emailLoginCode.updateMany({
      where: {
        userId,
        AND: [
          // Alt genug ODER schon eingelöst.
          { OR: [{ createdAt: { lte: limit } }, { consumedAt: { not: null } }] },
          // UND: ein laufender EINRICHTUNGScode wird von einem Anmeldecode
          // nicht überschrieben. Die Anforderungsroute ist anonym, es genügt
          // die Kennung — sonst könnte ein Fremder die Einrichtung des zweiten
          // Faktors beliebig oft abwürgen ([H2]). Umgekehrt darf die
          // Einrichtung (aus der Sitzung heraus) alles überschreiben.
          forSetup
            ? {}
            : {
                OR: [
                  { forSetup: false },
                  { expiresAt: { lte: now } },
                ],
              },
        ],
      },
      data: fields,
    });
    if (replaced.count === 1) {
      const written = await this.currentCode(userId);
      return {
        kind: 'generated',
        code,
        codeId: written?.id ?? '',
        createdAt: now,
        expiresAt,
      };
    }

    // Nicht ersetzt: es steht ein jüngerer, unverbrauchter Code. Die Restzeit
    // wird NUR für die Sitzungsroute gebraucht; die anonyme Route gibt sie
    // niemals heraus.
    const standing = await this.currentCode(userId);
    const age = standing ? now.getTime() - standing.createdAt.getTime() : 0;
    return {
      kind: 'too_early',
      secondsRemaining: Math.max(
        1,
        Math.ceil((CODE_AGAIN_BY_MS - age) / 1000),
      ),
    };
  }

  /**
   * Verwirft GENAU DEN Code, dessen Versand gescheitert ist.
   *
   * An Id UND Entstehungszeitpunkt gebunden, nicht an den Benutzer. Vorher
   * löschte `deleteMany({ benutzerId })` unbedingt die eine Zeile des Kontos —
   * welche auch immer gerade dort stand. Ein Versand, der später als 60
   * Sekunden scheitert, riss damit einen inzwischen erzeugten und bereits
   * ZUGESTELLTEN Code mit, und der Benutzer hielt einen Code in der Hand, den
   * der Server nicht mehr kannte ([W2]).
   */
  async discard(codeId: string, createdAt: Date): Promise<void> {
    // Bedingt auf BEIDES. Steht in der Zeile inzwischen ein neuerer Code, passt
    // `erstelltAm` nicht mehr und es wird nichts gelöscht.
    await this.prisma.emailLoginCode.deleteMany({
      where: { id: codeId, createdAt },
    });
  }

  /**
   * Löst einen Code ein.
   *
   * Ablauf und Reihenfolge sind wesentlich:
   *
   * - Erst der Zweck: ein Einrichtungscode schließt keine Anmeldung ab und
   *   umgekehrt. Sonst wäre eine Adressänderung zugleich ein zweiter Faktor.
   * - Dann der Ablauf — eine reine Zeitprüfung, kein Rennen möglich.
   * - Dann argon2. Passt der Code nicht, wird `fehlversuche` mit `increment`
   *   hochgezählt. Das ist ein `SET fehlversuche = fehlversuche + 1` in SQL und
   *   damit atomar: zwei gleichzeitige Fehlversuche ergeben zwei, nicht eins.
   * - Passt er, entwertet ein BEDINGTES `updateMany` (`verbrauchtAm: null`) den
   *   Code. Nur der erste von zwei gleichzeitigen Einlösungen trifft eine
   *   Zeile; der zweite bekommt `count === 0` und geht leer aus.
   */
  async resolve(
    userId: string,
    input: string,
    forSetup: boolean,
    now: Date = new Date(),
  ): Promise<RedeemResult> {
    const normalized = normalizeDigitCode(input);
    const record = await this.currentCode(userId);
    if (!record) return { kind: 'no_code' };
    // Bereits eingelöst: die Zeile steht nur noch als Anker der
    // 60-Sekunden-Sperre da und darf keine Fehlversuche mehr sammeln.
    if (record.consumedAt !== null) return { kind: 'no_code' };
    if (record.forSetup !== forSetup) {
      return { kind: 'wrong_purpose' };
    }
    if (record.expiresAt.getTime() <= now.getTime()) {
      return { kind: 'expired' };
    }
    if (record.failedAttempts >= CODE_MAX_FAILED_ATTEMPTS) {
      // Verbrannt und noch da (er ist der Anker der 60-Sekunden-Sperre). Das
      // wird BENANNT und nicht als „kein Code" verschwiegen — sonst sieht der
      // Benutzer beim zweiten Versuch wieder „falscher Code" und probiert
      // weiter an einem toten Code herum ([H1]).
      return { kind: 'burned' };
    }

    let matches = false;
    if (normalized.length === CODE_LENGTH) {
      try {
        matches = await argon2.verify(record.codeHash, normalized);
      } catch {
        // Beschädigter Hash: gilt als falscher Code, nicht als Serverfehler.
        matches = false;
      }
    }

    if (!matches) {
      const state = await this.prisma.emailLoginCode.update({
        where: { id: record.id },
        data: { failedAttempts: { increment: 1 } },
        select: { failedAttempts: true },
      });
      // Der verbrannte Datensatz bleibt BEWUSST stehen: er ist der Anker der
      // 60-Sekunden-Sperre. Würde er gelöscht, könnte ein Angreifer nach je
      // CODE_MAX_FEHLVERSUCHE Fehleingaben sofort einen frischen Code anfordern und so
      // weiterraten — genau das soll die Sperre verhindern.
      const burned = state.failedAttempts >= CODE_MAX_FAILED_ATTEMPTS;
      return { kind: 'wrong', failedAttempts: state.failedAttempts, burned };
    }

    const invalidated = await this.prisma.emailLoginCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (invalidated.count !== 1) {
      // Ein anderer Aufruf war eine Winzigkeit schneller.
      return { kind: 'no_code' };
    }
    return { kind: 'ok', codeId: record.id, targetEmail: record.targetEmail };
  }
}
