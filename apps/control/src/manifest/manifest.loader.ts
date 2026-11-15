import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';
import { parse as parseYaml } from 'yaml';
import { ManifestError, type Manifest } from './manifest.types';
import { checkBilling } from './sections/billing';
import { checkMail } from './sections/mail';
import { checkProduct } from './sections/product';
import { checkProvisioning } from './sections/provisioning';
import { checkUi } from './sections/ui';
import { isObject, type ErrorList } from './validation';

export const MANIFEST_PATH_PRESET = './saas-instant.manifest.yaml';
const KNOWN_SECTIONS = ['product', 'mail', 'billing', 'provisioning', 'ui'];

/** Validiert ein bereits geparstes Manifest. Wirft ManifestFehler mit allen Fehlern. */
export function checkManifest(raw: unknown, source = 'inline'): Manifest {
  const error: ErrorList = [];
  let root: Record<string, unknown> = {};
  if (raw === undefined || raw === null) {
    root = {};
  } else if (!isObject(raw)) {
    throw new ManifestError(source, ['Wurzel: muss ein Objekt sein']);
  } else {
    root = raw;
  }
  for (const k of Object.keys(root)) {
    if (!KNOWN_SECTIONS.includes(k)) {
      error.push(`${k}: unbekannter Abschnitt (erlaubt: ${KNOWN_SECTIONS.join(', ')})`);
    }
  }
  const manifest: Manifest = {
    product: checkProduct(root['product'], error),
    mail: checkMail(root['mail'], error),
    billing: checkBilling(root['billing'], error),
    provisioning: checkProvisioning(root['provisioning'], error),
    ui: checkUi(root['ui'], error),
  };
  if (error.length > 0) throw new ManifestError(source, error);
  return manifest;
}

/** Neutrale Vorgaben (alle Abschnitte leer geprüft). */
export function manifestPresets(): Manifest {
  return checkManifest({}, 'Vorgaben');
}

export interface LoadResult {
  manifest: Manifest;
  /** Pfad, aus dem geladen wurde; null = Datei fehlte, Vorgaben. */
  loadedFrom: string | null;
}

export function loadManifest(path: string): LoadResult {
  if (!existsSync(path)) {
    return { manifest: manifestPresets(), loadedFrom: null };
  }
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ManifestError(path, [`Datei lässt sich nicht lesen: ${(e as Error).message}`]);
  }
  return { manifest: checkManifest(raw, path), loadedFrom: path };
}
