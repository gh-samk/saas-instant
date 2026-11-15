import { registerDecorator, ValidationOptions } from 'class-validator';
import { dateFromString } from '@saas-instant/shared';

/**
 * Prüft, dass ein Feld ein gültiges TAGESDATUM `YYYY-MM-DD` ist (Regel 1 der
 * Projektkonventionen) — inklusive Kalenderprüfung: „2027-02-30" wird abgewiesen.
 *
 * Ohne diesen Validator landete ein unmögliches Datum erst in `zuDatum()` und
 * flöge dort als nackter `Error` heraus — also als 500 statt als 400 mit
 * Begründung.
 */
export function IsCalendarDate(options?: ValidationOptions) {
  return function (target: object, fieldName: string): void {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: fieldName,
      options: options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          try {
            dateFromString(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return `${fieldName} muss ein Tagesdatum im Format JJJJ-MM-TT sein.`;
        },
      },
    });
  };
}
