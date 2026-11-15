import type { DbClient } from '../prisma/db-client';

/**
 * Warum eine Adresse KEINE werbliche Mail bekommen darf. Feste Menge, damit
 * sich danach filtern und im Audit-Log zählen lässt.
 */
export type RejectionReason =
  | 'kein_eintrag'
  | 'nicht_bestaetigt'
  | 'unsubscribed'
  | 'hard_bounced'
  | 'spam_reported'
  | 'kein_abmeldetoken';

export type ApprovalCheck =
  | { granted: true; approval: MarketingApproval }
  | { granted: false; reason: RejectionReason };

/**
 * ===========================================================================
 * DAS TOR — R3 ALS TYP, NICHT ALS VERABREDUNG
 * ===========================================================================
 *
 * „Ein Empfänger ohne bestätigtes Opt-in kann technisch keine werbliche Mail
 * erhalten, auch nicht durch Fehlbedienung."
 *
 * Eine Prüfung, an die man sich erinnern muss, ist genau das, was die Regel
 * ausschließt. Deshalb steht sie hier im TYPSYSTEM: `WerbeMailService` nimmt
 * als Empfänger keine Zeichenkette entgegen, sondern ausschließlich eine
 * `WerbeFreigabe`. Und eine `WerbeFreigabe` gibt es nur aus `pruefe()`.
 *
 * Drei Sperren, und es ist wichtig zu wissen, WO jede von ihnen liegt:
 *
 * 1. DER KONSTRUKTOR IST PRIVAT. `new WerbeFreigabe(…)` ist ausserhalb dieser
 *    Klasse ein Übersetzungsfehler.
 * 2. DAS FELD `marke` IST PRIVAT. Damit scheitert auch der Umweg über ein
 *    passendes Objektliteral: TypeScript vergleicht private Felder nominal,
 *    nicht strukturell. `{ einwilligungId: …, email: … } as WerbeFreigabe`
 *    wird abgelehnt.
 *
 *    ===================================================================
 *    DIE BEIDEN ERSTEN SPERREN WIRKEN NUR ZUR ÜBERSETZUNGSZEIT ([H1]).
 *    ===================================================================
 *    `private` ist eine TypeScript-Angabe ohne Entsprechung im erzeugten
 *    JavaScript. Wer `Reflect.construct` benutzt oder ein Objekt mit dem
 *    passenden Feld baut, umgeht sie zur Laufzeit. DAS IST BEKANNT UND
 *    ÄNDERT NICHTS AN DER ZUSAGE: Diese Sperren richten sich gegen den
 *    nächsten Umbau, nicht gegen einen Angreifer — sie sollen verhindern,
 *    dass jemand die Prüfung aus Versehen umgeht. Über die API ist dieser
 *    Weg nicht erreichbar; dort kommt niemand an den Konstruktor.
 *    Ein `#marke` als echtes privates Feld wäre die Laufzeitfassung; es
 *    scheitert daran, dass die Klasse dann nicht mehr strukturell aus
 *    Prisma-Zeilen aufgebaut werden könnte, ohne den Nutzen zu erhöhen.
 *    DIE TRAGENDE SPERRE IST OHNEHIN DIE DRITTE.
 *
 * 3. `pruefe()` LIEST DIE DATENBANK — und DAS ist die Sperre, die zur
 *    Laufzeit trägt. Die Freigabe entsteht aus der gesperrten Zeile, nie aus
 *    einer Angabe des Aufrufers. Wer eine fremde Adresse einsetzen will, muss
 *    dafür eine bestätigte Einwilligung in der Datenbank haben — und dann ist
 *    es keine Umgehung mehr, sondern der reguläre Fall.
 *
 * WANN GEPRÜFT WIRD: unmittelbar vor dem SMTP-Aufruf, nicht bei der Auswahl.
 * Die Auswahl im Redaktionsbereich sagt nur voraus, wer die Mail bekommt; die
 * Entscheidung fällt hier. Zwischen beidem können Stunden liegen, und in
 * dieser Zeit kann jemand widerrufen.
 *
 * `db` MUSS EIN TRANSAKTIONS-CLIENT SEIN. `SELECT … FOR UPDATE` hält die
 * Sperre bis zum Ende der Transaktion; ausserhalb einer solchen wäre sie
 * sofort wieder weg und die Prüfung ein „check-then-act" mit einem Fenster
 * dazwischen. Die Abmeldung nimmt dieselbe Sperre auf dieselbe Zeile — damit
 * ist die Reihenfolge der beiden Vorgänge entschieden und nicht zufällig.
 */
export class MarketingApproval {
  /**
   * Nominale Marke. Privat, damit kein fremdes Objekt strukturell passt.
   * Der Wert ist bedeutungslos, die Zugriffsstufe ist alles.
   */
  private readonly brand: 'bestaetigtes-opt-in' = 'bestaetigtes-opt-in';

  private constructor(
    readonly consentId: string,
    readonly email: string,
    readonly unsubscribeToken: string,
    readonly companyId: string | null,
  ) {}

  /**
   * Der einzige Weg zu einer Freigabe: die Zeile sperren, ihren Zustand lesen
   * und nur bei `bestaetigt` erteilen.
   */
  static async check(
    db: DbClient,
    consentId: string,
  ): Promise<ApprovalCheck> {
    // Sperrt die Zeile bis zum Ende der umschliessenden Transaktion. Eine
    // gleichzeitige Abmeldung wartet hier — oder war vorher fertig, dann liest
    // die Abfrage unten bereits `abgemeldet`.
    await db.$queryRaw`SELECT "id" FROM "Consent" WHERE "id" = ${consentId} FOR UPDATE`;

    const row = await db.consent.findUnique({
      where: { id: consentId },
      select: {
        id: true,
        email: true,
        status: true,
        unsubscribeToken: true,
        companyId: true,
      },
    });
    if (!row) return { granted: false, reason: 'kein_eintrag' };

    switch (row.status) {
      case 'confirmed':
        break;
      case 'unconfirmed':
        return { granted: false, reason: 'nicht_bestaetigt' };
      case 'unsubscribed':
        return { granted: false, reason: 'unsubscribed' };
      case 'hard_bounced':
        return { granted: false, reason: 'hard_bounced' };
      case 'spam_reported':
        return { granted: false, reason: 'spam_reported' };
    }

    // OHNE ABMELDETOKEN KEINE MAIL. Jede werbliche Mail trägt einen
    // personalisierten Abmeldelink; eine ohne wäre nicht abbestellbar und
    // damit selbst dann unzulässig, wenn die Einwilligung vorliegt.
    if (!row.unsubscribeToken) {
      return { granted: false, reason: 'kein_abmeldetoken' };
    }

    return {
      granted: true,
      approval: new MarketingApproval(
        row.id,
        row.email,
        row.unsubscribeToken,
        row.companyId,
      ),
    };
  }
}
