import { registerDecorator, ValidationOptions } from 'class-validator';
import { dateFromString, datePlusDays, today } from '@saas-instant/shared';

/**
 * Wie viele Tage in der Zukunft noch durchgehen.
 *
 * Einer, nicht null: Zwischen der Uhr des meldenden Servers und der des CRM
 * liegen Zeitzone und Laufzeit. Ein Lauf, der um 23:58 UTC beginnt und um
 * 00:03 meldet, darf nicht abgewiesen werden — sonst fiele die Sicherung
 * regelmässig aus der Anzeige, und die Aufgabe „Sicherung überfällig" wäre
 * ein Fehlalarm.
 */
export const FUTURE_TOLERANCE_DAYS = 1;

/**
 * Prüft, dass ein Tagesdatum NICHT NENNENSWERT IN DER ZUKUNFT liegt.
 *
 * WOFÜR ES DAS GIBT ([K3]): Die Meldung einer Sicherung trägt ihr Datum
 * selbst. Ohne Obergrenze schaltet eine einzige Meldung mit `9999-12-31` die
 * Aufgabe „Sicherung überfällig" für diese Instanz DAUERHAFT ab — und weil es
 * (richtigerweise) keinen Löschpfad für `Sicherung` gibt, ist der Zustand
 * unumkehrbar. Es braucht dafür keinen Angreifer: ein vertauschtes
 * Datumsformat oder eine falsch gestellte Uhr im Wrapper-Skript genügt.
 *
 * Die Regel gilt für jedes Feld, dessen Wert eine BEREITS GESCHEHENE Tatsache
 * beschreibt. Für geplante Termine gilt sie ausdrücklich
 * NICHT — die liegen zu Recht in der Zukunft.
 */
export function IsPastDay(options?: ValidationOptions) {
  return function (target: object, fieldName: string): void {
    registerDecorator({
      name: 'isPastTag',
      target: target.constructor,
      propertyName: fieldName,
      options: options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          try {
            dateFromString(value);
          } catch {
            return false;
          }
          return value <= datePlusDays(today(), FUTURE_TOLERANCE_DAYS);
        },
        defaultMessage(): string {
          return `${fieldName} darf nicht in der Zukunft liegen.`;
        },
      },
    });
  };
}
