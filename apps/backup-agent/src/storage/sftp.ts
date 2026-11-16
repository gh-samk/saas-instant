import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type { StorageBoxConfig } from '../types.js';
import type { ObjectInfo, Storage } from './types.js';

/** OpenSSH-Schreibweise: 'SHA256:' + Base64 (ohne Padding) des SHA-256 ueber den Host-Key-Blob. */
export function hostKeyFingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Ohne gepinnten Host-Key wird nicht verbunden (ein Angreifer im Netz koennte sonst Passwort und Sicherungen abgreifen). */
export class HostKeyNotPinnedError extends Error {
  constructor() {
    super(
      'Der SFTP-Host-Key ist nicht gepinnt: Sicherungen und Wiederherstellung sind gesperrt. ' +
        'Fingerabdruck in den Sicherungseinstellungen (Erweitert) eintragen oder den Verbindungstest ausfuehren, der ihn beim ersten Kontakt festhaelt',
    );
  }
}

export class HostKeyMismatchError extends Error {
  constructor(expected: string, seen: string) {
    super(`SFTP-Host-Key weicht vom gespeicherten Fingerabdruck ab (erwartet ${expected}, gesehen ${seen}): Verbindung abgelehnt`);
  }
}

/** Hetzner Storage Box ueber SFTP (Port 23). Eine Verbindung je Operation. Host-Key: TOFU-Pinning. */
export class SftpStorage implements Storage {
  private observed: string | undefined;
  /** Gilt nur fuer diese Instanz (siehe `withTofu`); erster gesehener Schluessel bleibt fuer deren Verbindungen verbindlich. */
  private tofuKey: string | undefined;

  constructor(
    private readonly cfg: StorageBoxConfig,
    private readonly tofu = false,
  ) {}

  /**
   * Eigene Sicht fuer EINEN Verbindungstest: erlaubt den ersten Kontakt ohne Pin (TOFU). Der Zustand
   * gehoert zu der zurueckgegebenen Instanz, nicht zu dieser; parallele Verbindungen dieser Instanz
   * (Sicherung, Wiederherstellung) bleiben daher ohne Pin gesperrt.
   */
  withTofu(): SftpStorage {
    return new SftpStorage(this.cfg, true);
  }

  observedHostKey(): string | undefined {
    return this.observed;
  }

  private async open(): Promise<SftpClient> {
    if (!this.cfg.hostKeyFingerprint && !this.tofu) throw new HostKeyNotPinnedError();
    const c = new SftpClient();
    let mismatch: Error | undefined;
    let abort: (e: Error) => void = () => undefined;
    // ssh2-sftp-client meldet ein vom Verifier abgelehntes Handshake nicht als Fehler (Promise bleibt offen).
    const rejected = new Promise<never>((_, reject) => {
      abort = reject;
    });
    rejected.catch(() => undefined);
    try {
      await Promise.race([
        rejected,
        c.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        ...(this.cfg.authType === 'key' ? { privateKey: this.cfg.privateKey } : { password: this.cfg.password }),
        readyTimeout: 20_000,
        hostVerifier: (key: Buffer | string): boolean => {
          const seen = hostKeyFingerprint(Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex'));
          this.observed = seen;
          const pinned = this.cfg.hostKeyFingerprint ?? this.tofuKey;
          if (!pinned && this.tofu) this.tofuKey = seen;
          if (pinned && pinned !== seen) {
            mismatch = new HostKeyMismatchError(pinned, seen);
            abort(mismatch);
            return false;
          }
          return true;
        },
      } as Parameters<SftpClient['connect']>[0]),
      ]);
    } catch (e) {
      await c.end().catch(() => undefined);
      throw mismatch ?? e;
    }
    return c;
  }

  private root(): string {
    return this.cfg.path.startsWith('/') ? this.cfg.path : '/' + this.cfg.path;
  }

  private remote(key: string): string {
    return path.posix.join(this.root(), key);
  }

  private async with<T>(fn: (c: SftpClient) => Promise<T>): Promise<T> {
    const c = await this.open();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const remote = this.remote(key);
    await this.with(async (c) => {
      await c.mkdir(path.posix.dirname(remote), true);
      await c.put(body, remote);
    });
  }

  async get(key: string): Promise<Readable> {
    // Der Download laeuft ueber eine eigene Verbindung, die erst am Ende schliesst.
    const c = await this.open();
    const out = new PassThrough();
    c.get(this.remote(key), out)
      .catch((e: unknown) => out.destroy(e instanceof Error ? e : new Error('SFTP-Fehler')))
      .finally(() => void c.end().catch(() => undefined));
    return out;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const rootDir = this.root();
    return this.with(async (c) => {
      const out: ObjectInfo[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await c.list(dir);
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.posix.join(dir, e.name);
          if (e.type === 'd') await walk(full);
          else if (e.type === '-') {
            const rel = path.posix.relative(rootDir, full);
            if (rel.startsWith(prefix)) out.push({ key: rel, size: e.size, lastModified: new Date(e.modifyTime) });
          }
        }
      };
      // Nur den Teilbaum des Praefixes ablaufen.
      const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
      await walk(path.posix.join(rootDir, dirPart));
      return out;
    });
  }

  async head(key: string): Promise<ObjectInfo | null> {
    return this.with(async (c) => {
      try {
        const s = await c.stat(this.remote(key));
        return { key, size: s.size, lastModified: new Date(s.modifyTime) };
      } catch {
        return null;
      }
    });
  }

  async delete(key: string): Promise<void> {
    await this.with((c) => c.delete(this.remote(key)).then(() => undefined));
  }
}
