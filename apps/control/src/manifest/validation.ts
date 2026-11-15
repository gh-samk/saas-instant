/**
 * Gemeinsame Hilfen der Handvalidierung. Jeder Abschnitt sammelt seine Fehler
 * in einer Liste (Pfad + Meldung), statt beim ersten abzubrechen.
 */
export type ErrorList = string[];

export function isObject(w: unknown): w is Record<string, unknown> {
  return typeof w === 'object' && w !== null && !Array.isArray(w);
}

/** Liefert den Abschnitt als Objekt; fehlt er, ein leeres. Falscher Typ ist ein Fehler. */
export function sectionAsObject(
  raw: unknown,
  path: string,
  error: ErrorList,
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    error.push(`${path}: muss ein Objekt sein`);
    return {};
  }
  return raw;
}

export function textField(
  o: Record<string, unknown>,
  key: string,
  path: string,
  preset: string,
  error: ErrorList,
  opt: { notEmpty?: boolean; pattern?: RegExp; patternHint?: string } = {},
): string {
  const w = o[key];
  if (w === undefined || w === null) return preset;
  if (typeof w !== 'string') {
    error.push(`${path}.${key}: muss ein Text sein`);
    return preset;
  }
  if (opt.notEmpty && w.trim() === '') {
    error.push(`${path}.${key}: darf nicht leer sein`);
    return preset;
  }
  if (opt.pattern && !opt.pattern.test(w)) {
    error.push(`${path}.${key}: ${opt.patternHint ?? 'ungültiges Format'}`);
    return preset;
  }
  return w;
}

export function optionalTextField(
  o: Record<string, unknown>,
  key: string,
  path: string,
  error: ErrorList,
): string | null {
  const w = o[key];
  if (w === undefined || w === null || w === '') return null;
  if (typeof w !== 'string') {
    error.push(`${path}.${key}: muss ein Text sein`);
    return null;
  }
  return w;
}

export function numberField(
  o: Record<string, unknown>,
  key: string,
  path: string,
  preset: number,
  error: ErrorList,
  min = 0,
): number {
  const w = o[key];
  if (w === undefined || w === null) return preset;
  if (typeof w !== 'number' || !Number.isFinite(w) || w < min) {
    error.push(`${path}.${key}: muss eine Zahl >= ${min} sein`);
    return preset;
  }
  return w;
}

export function textMap(
  raw: unknown,
  path: string,
  error: ErrorList,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    error.push(`${path}: muss eine Zuordnung Name -> Text sein`);
    return {};
  }
  const from: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      from[k] = String(v);
    } else {
      error.push(`${path}.${k}: muss ein Text sein`);
    }
  }
  return from;
}
