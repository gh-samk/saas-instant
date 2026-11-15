import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { IsCalendarDate } from '../../common/validators/is-calendar-date';

/** Eine von Hand erfasste Notiz zu einer Organisation. */
export class NoteCreateDto {
  @IsUUID('4', { message: 'Unbekannte Organisation.' })
  companyId!: string;

  @IsString()
  @IsNotEmpty({ message: 'Die Notiz darf nicht leer sein.' })
  @MaxLength(4000)
  text!: string;

  /**
   * Tagesdatum der Notiz. Fehlt es, gilt heute. Bewusst frei wählbar: ein
   * Telefonat wird oft erst am Folgetag erfasst, und dann gehört es an den Tag
   * des Telefonats.
   */
  @IsOptional()
  @IsCalendarDate()
  date?: string;
}

/** Nur der eigene Text und das Datum lassen sich nachträglich ändern. */
export class NoteUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Die Notiz darf nicht leer sein.' })
  @MaxLength(4000)
  text?: string;

  @IsOptional()
  @IsCalendarDate()
  date?: string;
}

/** Verlauf je Organisation. */
export class NoteHistoryDto {
  @IsUUID('4', { message: 'Unbekannte Organisation.' })
  companyId!: string;
}
