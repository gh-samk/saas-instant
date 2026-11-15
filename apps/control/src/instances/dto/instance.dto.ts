import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsCalendarDate } from '../../common/validators/is-calendar-date';
import { IsPastDay } from '../../common/validators/is-past-day';
import { SUBDOMAIN_MAX } from '../../coolify/subdomain';

/** Die gewünschte Subdomain — im Vorschau- wie im Anlege-Schritt. */
export class SubdomainDto {
  @IsString()
  @IsNotEmpty({ message: 'Die Subdomain fehlt.' })
  @MaxLength(SUBDOMAIN_MAX, {
    message: `Die Subdomain darf höchstens ${SUBDOMAIN_MAX} Zeichen haben.`,
  })
  subdomain!: string;
}

/** Abfrage der Verfügbarkeit. */
export class SubdomainQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Die Subdomain fehlt.' })
  @MaxLength(SUBDOMAIN_MAX)
  value!: string;
}

/**
 * Eine gelungene Sicherung, gemeldet vom externen Sicherungswerkzeug.
 *
 * Bewusst eng: Subdomain, Tag, Grösse. Nichts über den Inhalt, nichts über
 * den Speicherort — das CRM soll aus dieser Meldung nicht lernen, wo die
 * Sicherungen liegen.
 */
export class BackupReportDto {
  @IsString()
  @IsNotEmpty({ message: 'Die Subdomain fehlt.' })
  @MaxLength(SUBDOMAIN_MAX)
  subdomain!: string;

  /**
   * Der Tag der Sicherung. NICHT IN DER ZUKUNFT ([K3]).
   *
   * Ohne Obergrenze schaltet eine einzige Meldung mit `9999-12-31` die Aufgabe
   * „Sicherung überfällig" für diese Instanz dauerhaft ab — unumkehrbar, weil
   * es für `Sicherung` bewusst keinen Löschpfad gibt.
   */
  @IsCalendarDate()
  @IsPastDay()
  date!: string;

  @IsInt({ message: 'Die Grösse muss eine ganze Zahl in Byte sein.' })
  @Min(0)
  // 10 TB. Eine Zahl darüber ist ein Tippfehler oder eine falsche Einheit,
  // kein Backup — und `Number.MAX_SAFE_INTEGER` wäre keine Schranke.
  @Max(10_995_116_277_760)
  sizeBytes!: number;
}
