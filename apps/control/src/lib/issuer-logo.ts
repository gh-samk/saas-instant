/** Logo-Vorgaben der Firmendaten; der Server prüft dieselben Grenzen erneut. */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;

export type LogoProblem = 'type' | 'size' | 'empty';

/** Prüft die Datei vor dem Hochladen: nur PNG/JPEG, höchstens 512 KB, nicht leer. */
export function validateLogoFile(file: { type: string; size: number }): LogoProblem | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size <= 0) return 'empty';
  if (file.size > LOGO_MAX_BYTES) return 'size';
  return null;
}
