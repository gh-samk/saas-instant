/**
 * Der Schlüssel, gegen den das Demo-Kontingent zählt.
 *
 * ABSICHTLICH ETWAS ANDERES ALS `normalisiereAdresse` (einwilligung/adresse.ts),
 * und die Begründung ist die umgekehrte Richtung des Schadens:
 *
 * - Dort geht es um IDENTITÄT (Sperrliste). Zwei Adressen zusammenzulegen, die
 *   in Wahrheit verschiedenen Menschen gehören, hiesse jemanden zu sperren, der
 *   das nie wollte. Deshalb dort NUR Kleinschreibung und Rand-Leerzeichen.
 * - Hier geht es um ein KONTINGENT. Zwei Adressen NICHT zusammenzulegen, die in
 *   Wahrheit dasselbe Postfach sind, heisst: unbegrenzt Post an ein fremdes
 *   Postfach. `opfer+1@`, `opfer+2@` … waren je eine neue Adresse, legten je
 *   eine neue Organisation an und lösten je eine Demo-Mail aus — bei fünf
 *   Anfragen je Minute rund siebentausend unaufgeforderte Mails am Tag,
 *   abgeschickt von der Maildomäne des Betreibers ([A.14]).
 *
 * Der schlimmste Fehlgriff hier ist, dass jemand keine zweite Demo bekommt und
 * sich melden muss. Der schlimmste Fehlgriff dort wäre, dass jemand keine Post
 * mehr bekommt, die er wollte. Deshalb dürfen die Regeln auseinandergehen.
 *
 * WAS ZUSAMMENGELEGT WIRD:
 * 1. Kleinschreibung und Rand-Leerzeichen — wie überall.
 * 2. Der `+…`-Zusatz im lokalen Teil. Er ist bei allen verbreiteten Anbietern
 *    ein Unteradressierungs-Merkmal desselben Postfachs.
 * 3. Punkte im lokalen Teil, aber NUR bei Gmail — dort und nur dort sind
 *    `a.b@` und `ab@` dasselbe Postfach.
 */

/** Anbieter, bei denen Punkte im lokalen Teil bedeutungslos sind. */
export const POINTS_IRRELEVANT = new Set(['gmail.com']);

/**
 * Domänen, die DASSELBE Postfach bedienen. `googlemail.com` ist Googles
 * zweiter Name für Gmail (in Deutschland lange der einzige) — ein Postfach,
 * zwei Adressen. Beide werden auf den ersten Namen abgebildet.
 */
export const DOMAINS_ALIASES: Record<string, string> = {
  'googlemail.com': 'gmail.com',
};

/** Die Bestandteile des Schlüssels — für Anwendung UND Datenbankabfrage. */
export interface QuotaParts {
  /** Lokaler Teil nach Normalisierung. */
  local: string;
  /** Kanonische Domäne (Aliase aufgelöst). */
  domain: string;
  /** Alle Schreibweisen der Domäne, die in der Datenbank zu suchen sind. */
  domainsSpellings: string[];
  /** Ob Punkte im lokalen Teil zu entfernen sind. */
  pointsIrrelevant: boolean;
}

/**
 * Zerlegt die Adresse so, dass die Datenbank dieselbe Regel anwenden kann.
 *
 * [Review A1] Die Zählung MUSS in der Datenbank stattfinden. Eine Vorauswahl
 * nach Domäne mit `take` in der Anwendung war ein füllbares Fenster: Wer 500
 * Zeilen mit anderen lokalen Teilen derselben Domäne anlegt, schiebt das Opfer
 * aus dem Fenster, und das Kontingent ist wieder umgangen. Deshalb liefert
 * diese Funktion die Bestandteile, und `oeffentlich.service.ts` formt daraus
 * eine Abfrage, die den Schlüssel in SQL nachbaut — ohne Obergrenze.
 */
export function quotaParts(raw: string): QuotaParts | null {
  const address = raw.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;

  let local = address.slice(0, at);
  const rawDomain = address.slice(at + 1);
  if (rawDomain === '') return null;
  const domain = DOMAINS_ALIASES[rawDomain] ?? rawDomain;

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  const pointsIrrelevant = POINTS_IRRELEVANT.has(domain);
  if (pointsIrrelevant) local = local.split('.').join('');

  const spellings = [domain].concat(
    Object.entries(DOMAINS_ALIASES)
      .filter(([, target]) => target === domain)
      .map(([alias]) => alias),
  );

  return { local, domain, domainsSpellings: spellings, pointsIrrelevant };
}

export function quotaKey(raw: string): string {
  const parts = quotaParts(raw);
  if (parts === null) return raw.trim().toLowerCase();
  return `${parts.local}@${parts.domain}`;
}

/** Der Domänenteil, für die grobe Vorauswahl in der Datenbank. */
export function domainFrom(raw: string): string | null {
  return quotaParts(raw)?.domain ?? null;
}
