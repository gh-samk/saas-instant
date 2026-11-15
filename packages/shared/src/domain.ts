/**
 * Lese-DTOs für Domänen (Domänen-Karte & Domänen-Log).
 */

export type DomainType = 'permanent_domain' | 'working_domain';

/**
 * Höchstzahl an Unter-Unterdomänen (Ebene 2) je Unterdomäne (Ebene 1).
 * Hauptdomänen (Ebene 0) und ihre Unterdomänen sind unbegrenzt; eine vierte
 * Ebene gibt es nicht. Begrenzung dient der Darstellbarkeit im Domänen-Baum.
 */
export const MAX_SUB_SUB_DOMAINS = 3;

/**
 * Ebene einer Domäne im Baum (0 = Haupt-, 1 = Unter-, 2 = Unter-Unterdomäne),
 * berechnet aus der flachen Liste. Bricht bei fehlendem Elternteil sicher ab.
 */
export function domainLevel(
  id: string,
  parentOf: (id: string) => string | null | undefined,
): number {
  let level = 0;
  let parent = parentOf(id);
  const seen = new Set<string>([id]);
  while (parent && !seen.has(parent)) {
    level += 1;
    seen.add(parent);
    parent = parentOf(parent);
  }
  return level;
}

/** Eine Domäne als Knoten der Domänen-Karte (inkl. Aktivitätszählungen). */
export interface DomainNodeDTO {
  id: string;
  name: string;
  goal: string;
  /** Kernaufgaben der Domäne. */
  tasks: string[];
  type: DomainType;
  parentDomainId: string | null;
  active: boolean;
  /** Ist die Domäne archiviert (reversibel deaktiviert)? */
  archived: boolean;
  /** Anzahl Vorschläge mit Beschluss. */
  decisionsCount: number;
  /** Summe Bedenken + Einwände auf noch offenen Vorschlägen. */
  openObjectionsCount: number;
}

/** Eine Domäne im Detail (Domänen-Log-Kopf), plus Name der Eltern-Domäne. */
export interface DomainDetailDTO extends DomainNodeDTO {
  parentDomainName: string | null;
}

/** Ein aktives Domänen-Mitglied, nur Name (für die Teilhabenden-Anzeige im Domänen-Log). */
export interface DomainMemberNameDTO {
  id: string;
  name: string;
  /** Personenspezifische Avatarfarben (aus Seed/Profil) oder null. */
  avatarColor: string | null;
  avatarTextColor: string | null;
}
