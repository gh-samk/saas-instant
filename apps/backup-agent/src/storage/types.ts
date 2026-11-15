import type { Readable } from 'node:stream';

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface PutOptions {
  /** Object-Lock-Aufbewahrung (nur S3, Modus GOVERNANCE). */
  retainUntil?: Date;
}

/** Schluessel sind relativ zur Wurzel des Ziels; Pfadanteile wie `..` sind bereits ausgeschlossen. */
export interface Storage {
  put(key: string, body: Readable | Buffer, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Readable>;
  list(prefix: string): Promise<ObjectInfo[]>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** Nur SFTP: Fingerabdruck des zuletzt gesehenen Host-Keys (fuer TOFU-Pinning). */
  observedHostKey?(): string | undefined;
}
