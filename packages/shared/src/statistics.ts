/**
 * Antwort-DTOs der Statistik-Auswertungen. Reine Aggregationen über dieselbe
 * Datenbasis; keine eigenen Daten. Alle Datumsfelder sind reine Kalenderdaten.
 */

/** Aktive Mitgliedschaften je Domäne (Domäne). */
export interface UsersPerDomain {
  domainId: string;
  domainName: string;
  count: number;
}

/** Anzahl Bedenken je Kalendermonat (Monat = YYYY-MM). */
export interface ConcernsPerMonth {
  month: string;
  count: number;
}

/** Bedenken und Einwände (getrennt nach Schweregrad) je Domäne. */
export interface DomainObjectionsConcerns {
  domainId: string;
  domainName: string;
  concerns: number;
  objectionsMinor: number;
  objectionsSevere: number;
}

/** Beschlüsse je Domäne. */
export interface DomainDecisions {
  domainId: string;
  domainName: string;
  decisions: number;
}
