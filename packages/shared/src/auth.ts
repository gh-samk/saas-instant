/**
 * Gemeinsame DTO-Typen rund um Authentifizierung und Konto.
 * Von der API (Antwort-Form) und vom Web-Frontend (AuthContext) genutzt.
 */

/** Soziokratische Funktionsrolle in einer Domäne (ohne Sonderrechte). */
export type RoleType = 'moderation' | 'logkeeper' | 'delegates';

/** Eine Domäne, in der die Person Mitglied ist, samt ihrer dortigen Rollen. */
export interface DomainWithRoles {
  domainId: string;
  name: string;
  roles: RoleType[];
}

/**
 * Die aktuell angemeldete Person (Antwort von GET /api/auth/ich).
 * Enthält NIEMALS passwortHash.
 */
export interface CurrentPersonDTO {
  id: string;
  name: string;
  /** Anzeigename (z. B. „Marek K."), getrennt vom vollständigen Namen. */
  displayName: string | null;
  username: string;
  loginEmail: string;
  isAdmin: boolean;
  notificationsEnabled: boolean;
  /** Öffentlicher Pfad des hochgeladenen Avatarbilds (oder null). */
  avatarUrl: string | null;
  /** Personenspezifische Avatarfarbe (Hintergrund, aus Seed/Profil). */
  avatarColor: string | null;
  /** Passende Vordergrund-/Textfarbe für die Initialen (aus Seed/Profil). */
  avatarTextColor: string | null;
  /** Ist die Zwei-Faktor-Authentisierung für dieses Konto aktiviert? */
  twoFactorEnabled: boolean;
  /** „Mitglied seit" – Datum der Kontoanlage (YYYY-MM-DD). */
  createdAt: string;
  /** „Zuletzt geändert am" für das Passwort (YYYY-MM-DD) oder null. */
  passwordChangedAt: string | null;
  companyName: string;
  domains: DomainWithRoles[];
}
