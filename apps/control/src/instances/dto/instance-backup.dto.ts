import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { SUBDOMAIN_MAX } from '../../coolify/subdomain';
import { SecondFactorEvidenceDto } from '../../backup-settings/dto/backup-settings.dto';

/** POST /api/instances/:id/restores. */
export class RestoreStartDto extends SecondFactorEvidenceDto {
  @IsUUID('all', { message: 'Die Sicherung ist ungültig.' })
  backupId!: string;

  @IsString()
  @IsNotEmpty({ message: 'Die neue Subdomain fehlt.' })
  @MaxLength(SUBDOMAIN_MAX)
  newSubdomain!: string;

  /**
   * Privater age-Schlüssel. WRITE-ONLY: nur im Arbeitsspeicher, geht an den
   * Agent, wird nie gespeichert, protokolliert oder zurückgegeben.
   */
  @IsString()
  @Matches(/^AGE-SECRET-KEY-1[A-Z0-9]{40,200}$/, {
    message: 'Das ist kein privater age-Schlüssel (AGE-SECRET-KEY-1…).',
  })
  ageIdentity!: string;

  /** Muss dem Subdomain-Namen der Instanz entsprechen. */
  @IsString()
  @IsNotEmpty({ message: 'Zur Bestätigung muss der Instanzname eingetippt werden.' })
  @MaxLength(SUBDOMAIN_MAX)
  confirmName!: string;
}

/** Nur der Nachweis des zweiten Faktors (Sicherung jetzt, Übernahme, Test). */
export class EvidenceOnlyDto extends SecondFactorEvidenceDto {}
