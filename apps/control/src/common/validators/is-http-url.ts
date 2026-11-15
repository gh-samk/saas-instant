import { registerDecorator, ValidationOptions } from 'class-validator';
import { isHttpUrl } from '../http-url';

/**
 * Das Feld muss leer sein oder eine http(s)-Adresse. Alles andere
 * (`javascript:`, `data:`, `//host`, Text) wird mit 400 abgewiesen.
 */
export function IsHttpUrl(options?: ValidationOptions) {
  return function (target: object, fieldName: string): void {
    registerDecorator({
      name: 'isHttpUrl',
      target: target.constructor,
      propertyName: fieldName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === '') return true;
          return isHttpUrl(value);
        },
        defaultMessage(): string {
          return `${fieldName} muss eine Adresse mit http:// oder https:// sein.`;
        },
      },
    });
  };
}
