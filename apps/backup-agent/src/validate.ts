import type { InstanceSpec, S3Config, StorageBoxConfig, TargetConfig } from './types.js';

/** Fehlertext nennt nur Feldnamen, nie Werte (koennten Geheimnisse sein). */
export class ValidationError extends Error {}

const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DBIDENT = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$/;
const UPLOADS_PATH = /^\/[A-Za-z0-9_./-]{1,200}$/;
const OBJECT_KEY = /^[A-Za-z0-9_./=-]{1,500}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/;
export const HOST_KEY_FP = /^SHA256:[A-Za-z0-9+/]{43}$/;
const AGE_IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]{20,}$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, field: string, re?: RegExp, optional = false): string | undefined {
  const v = o[field];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new ValidationError(`Feld ${field} fehlt`);
  }
  if (typeof v !== 'string') throw new ValidationError(`Feld ${field} muss Text sein`);
  if (re && !re.test(v)) throw new ValidationError(`Feld ${field} ist ungueltig`);
  return v;
}

/**
 * Geheimfeld: optional, wenn schon ein Ziel gleichen Typs gespeichert ist UND sich die Gegenstelle
 * nicht geaendert hat (`sameEndpoint`); dann bleibt der alte Wert. Wer das Ziel auf einen anderen Host
 * zeigt, koennte sonst das gespeicherte Passwort an eine fremde Stelle schicken lassen, ohne es zu kennen.
 */
function secret(
  o: Record<string, unknown>,
  field: string,
  label: string,
  old: string | undefined,
  sameEndpoint: boolean,
  again: string,
): string {
  const v = str(o, field, undefined, true);
  if (v !== undefined) return v;
  if (old && sameEndpoint) return old;
  if (old) throw new ValidationError(`Geheimfeld ${label} fehlt: ${again} (Ziel geaendert, der gespeicherte Wert wird nicht uebernommen)`);
  throw new ValidationError(
    `Geheimfeld ${label} fehlt: Es ist noch kein Ziel gleichen Typs gespeichert, dessen Wert beibehalten werden koennte`,
  );
}

function noDotDot(field: string, v: string) {
  if (v.split('/').includes('..')) throw new ValidationError(`Feld ${field} ist ungueltig`);
}

export function parseInstanceSpec(v: unknown, field = 'instance'): InstanceSpec {
  if (!isRecord(v)) throw new ValidationError(`Feld ${field} fehlt`);
  const uploadsService = str(v, 'uploadsService', SERVICE, true);
  const uploadsPath = str(v, 'uploadsPath', UPLOADS_PATH, true);
  if (uploadsPath) noDotDot('uploadsPath', uploadsPath);
  if (!!uploadsService !== !!uploadsPath) {
    throw new ValidationError('uploadsService und uploadsPath gehoeren zusammen');
  }
  return {
    subdomain: str(v, 'subdomain', SUBDOMAIN)!,
    composeProject: str(v, 'composeProject', PROJECT)!,
    dbService: str(v, 'dbService', SERVICE)!,
    dbName: str(v, 'dbName', DBIDENT)!,
    dbUser: str(v, 'dbUser', DBIDENT)!,
    ...(uploadsService ? { uploadsService, uploadsPath } : {}),
  };
}

export function parseObjectKey(v: unknown): string {
  if (typeof v !== 'string' || !OBJECT_KEY.test(v) || v.startsWith('/') || v.split('/').includes('..')) {
    throw new ValidationError('Feld objectKey ist ungueltig');
  }
  return v;
}

export function parseAgeIdentity(v: unknown): string {
  if (typeof v !== 'string' || !AGE_IDENTITY.test(v.trim())) {
    throw new ValidationError('Feld ageIdentity ist ungueltig');
  }
  return v.trim();
}

export function parseSha256(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new ValidationError('Feld sha256 ist ungueltig');
  return v.toLowerCase();
}

export function parseSubdomain(v: string): string {
  if (!SUBDOMAIN.test(v)) throw new ValidationError('Feld subdomain ist ungueltig');
  return v;
}

/**
 * Prueft den Zielkonfig-Body. `existing` liefert bei gleichem Typ die schon
 * gespeicherten Geheimnisse nach, wenn die Verwaltung sie nicht erneut sendet
 * (sie speichert keine).
 */
export function parseTarget(v: unknown, existing?: TargetConfig): TargetConfig {
  if (!isRecord(v)) throw new ValidationError('Body muss ein Objekt sein');
  const type = v['type'];
  if (type !== 's3' && type !== 'storagebox') throw new ValidationError('Feld type ist ungueltig');
  const schedule = v['schedule'];
  if (schedule !== 'daily' && schedule !== 'twice_daily') throw new ValidationError('Feld schedule ist ungueltig');
  const retentionDays = v['retentionDays'];
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new ValidationError('Feld retentionDays ist ungueltig');
  }
  const objectLock = v['objectLock'];
  if (typeof objectLock !== 'boolean') throw new ValidationError('Feld objectLock ist ungueltig');
  const base = { type, schedule, retentionDays, objectLock } as const;

  if (type === 's3') {
    const s = v['s3'];
    if (!isRecord(s)) throw new ValidationError('Feld s3 fehlt');
    const old = existing?.type === 's3' ? existing.s3 : undefined;
    const endpoint = str(s, 'endpoint')!;
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x');
    } catch {
      throw new ValidationError('Feld s3.endpoint ist ungueltig');
    }
    if (typeof s['pathStyle'] !== 'boolean') throw new ValidationError('Feld s3.pathStyle ist ungueltig');
    const prefix = (str(s, 'prefix', /^[A-Za-z0-9_./-]*$/, true) ?? '').replace(/^\/+|\/+$/g, '');
    noDotDot('s3.prefix', prefix);
    // Gespeicherte Werte nur bei gleichem Endpunkt und Bucket weiterverwenden.
    const sameS3 = !!old && old.endpoint === endpoint && old.bucket === (s['bucket'] as unknown);
    const accessKeyId = secret(s, 'accessKeyId', 's3.accessKeyId', old?.accessKeyId, sameS3, 'Gib die Zugangskennung erneut ein');
    // Das Geheimnis haengt an der Kennung: eine neue Kennung ohne neues Geheimnis wird nie mit dem alten gepaart.
    const sameKeyId = sameS3 && accessKeyId === old?.accessKeyId;
    const secretAccessKey = secret(s, 'secretAccessKey', 's3.secretAccessKey', old?.secretAccessKey, sameKeyId, 'Gib den geheimen Zugangsschluessel erneut ein');
    const cfg: S3Config = {
      endpoint,
      region: str(s, 'region', /^[A-Za-z0-9-]{1,40}$/)!,
      bucket: str(s, 'bucket', BUCKET)!,
      prefix,
      pathStyle: s['pathStyle'],
      accessKeyId,
      secretAccessKey,
    };
    return { ...base, s3: cfg };
  }

  const b = v['storagebox'];
  if (!isRecord(b)) throw new ValidationError('Feld storagebox fehlt');
  const old = existing?.type === 'storagebox' ? existing.storagebox : undefined;
  const authType = b['authType'];
  if (authType !== 'key' && authType !== 'password') throw new ValidationError('Feld storagebox.authType ist ungueltig');
  const port = b['port'] ?? 23;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('Feld storagebox.port ist ungueltig');
  }
  const path = str(b, 'path', /^\/?[A-Za-z0-9_./-]{0,200}$/)!;
  noDotDot('storagebox.path', path);
  const cfg: StorageBoxConfig = {
    host: str(b, 'host', HOST)!,
    port,
    username: str(b, 'username', /^[A-Za-z0-9_.-]{1,64}$/)!,
    path,
    authType,
  };
  // Passwort/Schluessel nur bei unveraendertem Host, Port und Benutzer weiterverwenden.
  const sameBox = !!old && old.host === cfg.host && old.port === cfg.port && old.username === cfg.username;
  if (authType === 'key') {
    cfg.privateKey = secret(b, 'privateKey', 'storagebox.privateKey', old?.privateKey, sameBox, 'Gib den privaten Schluessel erneut ein');
  } else {
    cfg.password = secret(b, 'password', 'storagebox.password', old?.password, sameBox, 'Gib das Passwort erneut ein');
  }
  // Host-Key: vorgegeben (Pflichtvergleich ab dem ersten Kontakt) oder, bei
  // unveraendertem Host/Port, der bereits gepinnte Wert. Anderer Host = neues TOFU.
  const fp = str(b, 'hostKeyFingerprint', HOST_KEY_FP, true);
  if (fp) cfg.hostKeyFingerprint = fp;
  else if (old?.hostKeyFingerprint && old.host === cfg.host && old.port === cfg.port) {
    cfg.hostKeyFingerprint = old.hostKeyFingerprint;
  }
  return { ...base, storagebox: cfg };
}
