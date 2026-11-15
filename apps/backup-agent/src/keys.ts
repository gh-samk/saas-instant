import type { BackupKind } from './types.js';

export function stamp(d: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const SET_SUFFIX = /(\.dump\.age|\.uploads\.tar\.age|\.tar\.age|\.meta\.json)$/;

export function setBase(key: string): string {
  return key.replace(SET_SUFFIX, '');
}

export function metaKeyFor(objectKey: string): string {
  return setBase(objectKey) + '.meta.json';
}

export function uploadsKeyFor(dumpKey: string): string {
  return setBase(dumpKey) + '.uploads.tar.age';
}

export function dateOfKey(key: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})T\d{6}Z/.exec(key.split('/').pop() ?? '');
  return m ? m[1]! : null;
}

/** Rechnungsarchive sind unantastbar: nie loeschen, nie aufraeumen (R1/GoBD). */
export function isProtectedKey(key: string): boolean {
  return /(^|\/)invoices\//.test(key);
}

export function kindOfKey(key: string): BackupKind | null {
  if (/(^|\/)instances\/[^/]+\/[^/]+\.dump\.age$/.test(key)) return 'instance';
  if (/(^|\/)control\/[^/]+\.dump\.age$/.test(key)) return 'control';
  if (/(^|\/)invoices\/\d{4}\/[^/]+\.tar\.age$/.test(key)) return 'invoices';
  return null;
}

export function subdomainOfKey(key: string): string | undefined {
  return /(^|\/)instances\/([^/]+)\//.exec(key)?.[2];
}

export const TEST_PREFIX = '.agent-test/';
