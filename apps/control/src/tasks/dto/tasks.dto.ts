import { IsOptional } from 'class-validator';
import { IsCalendarDate } from '../../common/validators/is-calendar-date';

/** Filter der Aufgabenliste. */
export class TasksQueryDto {
  /**
   * „Seit dem letzten Blick" — ab welchem Tag automatische Statuswechsel
   * gemeldet werden. Ohne Angabe gilt eine Woche zurück.
   *
   * Kommt vom Aufrufer, weil es im Datenmodell kein Feld für den letzten
   * Besuch gibt. Das ist eine gemeldete Lücke, keine Bequemlichkeit.
   */
  @IsOptional()
  @IsCalendarDate()
  since?: string;
}
