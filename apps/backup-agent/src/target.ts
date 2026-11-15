import { randomBytes } from 'node:crypto';
import { newKeyPair } from './age.js';
import { TEST_PREFIX } from './keys.js';
import { type Redactor, safeMessage } from './log.js';
import { type StorageFactory, keyPrefixOf } from './storage/index.js';
import type { Storage } from './storage/types.js';
import type { StateStore } from './state.js';
import type { TargetConfig, TargetState } from './types.js';
import { parseTarget } from './validate.js';

export interface CurrentTarget {
  target: TargetConfig;
  recipient: string;
  storage: Storage;
  keyPrefix: string;
}

export class TargetService {
  private state: TargetState | null = null;
  private storage: Storage | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly factory: StorageFactory,
    private readonly redactor: Redactor,
  ) {}

  async init(): Promise<void> {
    this.state = await this.store.load();
    if (this.state) {
      this.registerSecrets(this.state.target);
      this.storage = this.factory(this.state.target);
    }
  }

  isConfigured(): boolean {
    return this.state !== null;
  }

  current(): CurrentTarget | null {
    if (!this.state || !this.storage) return null;
    return {
      target: this.state.target,
      recipient: this.state.ageRecipient,
      storage: this.storage,
      keyPrefix: keyPrefixOf(this.state.target),
    };
  }

  /** Nur Metadaten, nie Geheimnisse (kein accessKeyId, keine Schluessel, keine Passwoerter). */
  metadata(): Record<string, unknown> {
    if (!this.state) return { configured: false };
    const { target, ageRecipient } = this.state;
    const common = {
      configured: true,
      type: target.type,
      schedule: target.schedule,
      retentionDays: target.retentionDays,
      objectLock: target.objectLock,
      ageRecipient,
    };
    if (target.type === 's3') {
      const s = target.s3!;
      return { ...common, endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix, pathStyle: s.pathStyle };
    }
    const b = target.storagebox!;
    return {
      ...common,
      host: b.host,
      port: b.port,
      username: b.username,
      path: b.path,
      authType: b.authType,
      hostKeyFingerprint: b.hostKeyFingerprint ?? null,
    };
  }

  /** Die Antwort enthaelt den privaten age-Schluessel genau einmal: bei der Ersteinrichtung. Er wird nicht gespeichert. */
  async put(body: unknown): Promise<{ ok: true; ageRecipient: string; ageIdentity?: string }> {
    const target = parseTarget(body, this.state?.target);
    let recipient = this.state?.ageRecipient;
    let identity: string | undefined;
    if (!recipient) {
      const kp = await newKeyPair();
      recipient = kp.recipient;
      identity = kp.identity;
      this.redactor.add(identity);
    }
    this.registerSecrets(target);
    const next: TargetState = { target, ageRecipient: recipient };
    await this.store.save(next);
    this.state = next;
    this.storage = this.factory(target);
    return { ok: true, ageRecipient: recipient, ...(identity ? { ageIdentity: identity } : {}) };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const cur = this.current();
    if (!cur) return { ok: false, message: 'Kein Ziel eingerichtet' };
    const key = `${cur.keyPrefix}${TEST_PREFIX}${randomBytes(8).toString('hex')}.txt`;
    const payload = Buffer.from(`saas-instant backup-agent test ${randomBytes(8).toString('hex')}`);
    try {
      await cur.storage.put(key, payload);
      const stream = await cur.storage.get(key);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
      if (!Buffer.concat(chunks).equals(payload)) return { ok: false, message: 'Gelesene Daten weichen ab' };
      await cur.storage.delete(key);
      const pinned = await this.pinHostKey(cur);
      return {
        ok: true,
        message: 'Schreiben, Lesen, Vergleichen und Loeschen erfolgreich' + (pinned ? `; SFTP-Host-Key gepinnt (${pinned})` : ''),
      };
    } catch (e) {
      return { ok: false, message: safeMessage(this.redactor, e) };
    }
  }

  /** TOFU: Beim ersten erfolgreichen Test wird der gesehene SFTP-Host-Key im Zustand gespeichert. */
  private async pinHostKey(cur: CurrentTarget): Promise<string | undefined> {
    const b = cur.target.storagebox;
    if (cur.target.type !== 'storagebox' || !b || b.hostKeyFingerprint || !this.state) return undefined;
    const seen = cur.storage.observedHostKey?.();
    if (!seen) return undefined;
    const target: TargetConfig = { ...cur.target, storagebox: { ...b, hostKeyFingerprint: seen } };
    const next: TargetState = { ...this.state, target };
    await this.store.save(next);
    this.state = next;
    this.storage = this.factory(target);
    return seen;
  }

  private registerSecrets(t: TargetConfig): void {
    this.redactor.add(t.s3?.secretAccessKey);
    this.redactor.add(t.s3?.accessKeyId);
    this.redactor.add(t.storagebox?.password);
    this.redactor.add(t.storagebox?.privateKey);
  }
}
