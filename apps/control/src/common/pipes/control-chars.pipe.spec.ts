import { ControlCharsError, ControlCharsPipe } from './control-chars.pipe';
import type { ArgumentMetadata } from '@nestjs/common';

const BODY = { type: 'body' } as ArgumentMetadata;
const PARAMETER = { type: 'param' } as ArgumentMetadata;

/**
 * [W8]: Ein NUL-Byte in einem Textfeld endete als `500 interner_fehler` — am
 * einzigen unauthentifizierten Schreibweg.
 */
describe('ControlCharsPipe', () => {
  const pipe = new ControlCharsPipe();

  it('weist ein NUL-Byte im Koerper ab', () => {
    expect(() =>
      pipe.transform({ email: 'gast@example.com', name: 'A\u0000B' }, BODY),
    ).toThrow(ControlCharsError);
  });

  it('nennt das betroffene Feld, ohne den Inhalt zu wiederholen', () => {
    try {
      pipe.transform({ deep: { name: 'A\u0000B' } }, BODY);
      fail('Es haette ein SteuerzeichenFehler kommen muessen.');
    } catch (error) {
      expect(error).toBeInstanceOf(ControlCharsError);
      const detail = (error as ControlCharsError).errorDetail as {
        field: string;
      };
      expect(detail.field).toBe('body.deep.name');
      expect((error as ControlCharsError).message).not.toContain('A');
    }
  });

  it('findet Steuerzeichen auch in Listen', () => {
    expect(() =>
      pipe.transform({ list: ['ok', 'schlecht\u0007'] }, BODY),
    ).toThrow(ControlCharsError);
  });

  it('laesst Zeilenumbruch und Tabulator durch', () => {
    // Eine mehrzeilige Nachricht ist zulaessige Eingabe. Was sie in einer
    // Notiz anrichten kann, verhindert `fremdtext.ts`.
    const body = { message: 'Zeile eins\nZeile zwei\tEingerueckt\r\n' };
    expect(pipe.transform(body, BODY)).toBe(body);
  });

  it('laesst gewoehnliche Eingaben unveraendert durch', () => {
    const body = { email: 'gast@example.com', name: 'Anna Berg' };
    expect(pipe.transform(body, BODY)).toBe(body);
  });

  it('prueft nur Koerper und Abfrage, nicht jeden Parameter', () => {
    // Pfadparameter sind Kennungen; sie gehen nicht als Text in die Datenbank.
    expect(pipe.transform('A\u0000B', PARAMETER)).toBe('A\u0000B');
  });
});
