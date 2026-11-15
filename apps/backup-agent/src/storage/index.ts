import type { TargetConfig } from '../types.js';
import { withDeleteGuard } from './guard.js';
import { S3Storage } from './s3.js';
import { SftpStorage } from './sftp.js';
import type { Storage } from './types.js';

export type StorageFactory = (target: TargetConfig) => Storage;

export const defaultStorageFactory: StorageFactory = (target) => {
  if (target.type === 's3') return withDeleteGuard(new S3Storage(target.s3!));
  return withDeleteGuard(new SftpStorage(target.storagebox!));
};

/** Praefix aller Schluessel dieses Ziels (S3: konfigurierter Praefix; Storage Box: Wurzelpfad im Adapter). */
export function keyPrefixOf(target: TargetConfig): string {
  if (target.type === 's3' && target.s3!.prefix) return target.s3!.prefix.replace(/^\/+|\/+$/g, '') + '/';
  return '';
}

export type { Storage } from './types.js';
