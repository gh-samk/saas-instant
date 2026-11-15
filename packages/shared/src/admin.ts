/**
 * Lese-DTOs für die Admin-Verwaltungsoberfläche (Personen- und Domäne/Rollen-
 * Verwaltung). Alle Datumsfelder sind reine Kalenderdaten (YYYY-MM-DD).
 */
import type { DomainWithRoles, RoleType } from './auth';

/** Abgeleiteter Kontostatus einer Person. */
export type PersonStatus = 'active' | 'deactivated' | 'invited';

/** Abgeleitete Software-Berechtigung (null bei noch nicht eingelösten Einladungen). */
export type PersonPermission =
  | 'Administrativ'
  | 'Protokollierend'
  | 'Teilhabend'
  | null;

/** Eine Person aus Admin-Sicht, inkl. ihrer aktuellen Domänen/Rollen. */
export interface AdminPersonDTO {
  id: string;
  name: string;
  username: string;
  loginEmail: string;
  /** Personenspezifische Avatarfarbe (Hintergrund) oder null. */
  avatarColor: string | null;
  /** Passende Vordergrund-/Textfarbe für die Initialen oder null. */
  avatarTextColor: string | null;
  isAdmin: boolean;
  active: boolean;
  /** Abgeleitet: deaktiviert (!aktiv) / eingeladen (aktiv ohne Passwort) / aktiv. */
  status: PersonStatus;
  /** Abgeleitete Software-Berechtigung (null solange nur eingeladen). */
  permission: PersonPermission;
  notificationsEnabled: boolean;
  createdAt: string;
  domains: DomainWithRoles[];
}

/** Eine aktuelle Rollenzuweisung einer Person in einem Domäne. */
export interface DomainMemberRoleDTO {
  roleId: string;
  roleType: RoleType;
  validFrom: string;
}

/** Ein aktuelles Mitglied eines Domäne samt seiner Rollen dort. */
export interface DomainMemberDTO {
  membershipId: string;
  personId: string;
  name: string;
  username: string;
  validFrom: string;
  roles: DomainMemberRoleDTO[];
}

/** Domäne-Detail für die Admin-Verwaltung: aktuelle Mitglieder + Rollen. */
export interface DomainMembersDTO {
  domainId: string;
  domainName: string;
  members: DomainMemberDTO[];
}
