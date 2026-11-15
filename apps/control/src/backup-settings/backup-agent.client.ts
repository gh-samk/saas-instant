import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authHeaders } from './agent-signature';
import {
  BackupAgentNotConfiguredError,
  BackupAgentRejectedError,
  BackupAgentUnavailableError,
} from './backup-agent.errors';
import type {
  AgentBackupEntry,
  AgentJob,
  AgentJobRequest,
  AgentTarget,
  AgentTargetUpdate,
} from './backup-agent.types';

/** Standardadresse im internen Compose-Netz. */
export const BACKUP_AGENT_URL_DEFAULT = 'http://backup-agent:8787';
/** Mindestlänge des gemeinsamen Geheimnisses (install.sh erzeugt 64 Hex-Zeichen). */
export const BACKUP_AGENT_SECRET_MIN_LENGTH = 32;
/** Mehr als 1 MiB lehnt der Agent ab; wir senden es gar nicht erst. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * DIE ERLAUBTEN HTTP-METHODEN gegen den Agent. Es gibt KEIN DELETE: Die
 * Verwaltung kann beim Agent nichts löschen lassen (R1/R4). Der Spec
 * `backup-agent.client.spec.ts` prüft diese Liste und die Methodenliste der
 * Klasse nach.
 */
export type AgentMethod = 'GET' | 'PUT' | 'POST';

/** Entfernt alles, was wie ein age-Schlüssel aussieht, aus fremdem Text. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/AGE-SECRET-KEY-[A-Z0-9]+/gi, '[entfernt]');
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[entfernt]');
  }
  return out;
}

/**
 * Der Client der Verwaltung für den Sicherungs-Agent (HTTP/JSON, HMAC-signiert).
 *
 * GEHEIMNISSE gehen nur DURCH: Der Client protokolliert weder Bodys noch
 * Antworten, sondern nur Methode, Pfad ohne Query und Statuscode. Fehlertexte
 * des Agents werden gekürzt und von age-Schlüsseln gesäubert.
 *
 * ABSCHLIESSENDE METHODENLISTE (nachgeprüft): health, getTarget, putTarget,
 * testTarget, startJob, getJob, listBackups. Nichts, was entfernt.
 */
@Injectable()
export class BackupAgentClient {
  private readonly logger = new Logger(BackupAgentClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return this.secret() !== null;
  }

  health(): Promise<{ status: string; version: string; targetConfigured: boolean }> {
    return this.call('GET', '/v1/health');
  }

  getTarget(): Promise<AgentTarget> {
    return this.call('GET', '/v1/target');
  }

  putTarget(update: AgentTargetUpdate): Promise<{
    ok: true;
    ageRecipient: string;
    ageIdentity?: string;
  }> {
    return this.call('PUT', '/v1/target', update);
  }

  testTarget(): Promise<{ ok: boolean; message: string }> {
    return this.call('POST', '/v1/target/test', {});
  }

  /** Stößt einen Auftrag an; der restore-Auftrag trägt den privaten Schlüssel NUR im Body. */
  startJob(request: AgentJobRequest): Promise<{ jobId: string }> {
    return this.call('POST', '/v1/jobs', request, [
      request.kind === 'restore' ? request.ageIdentity : '',
    ]);
  }

  getJob(jobId: string): Promise<AgentJob> {
    return this.call('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  listBackups(filter: {
    kind: 'instance' | 'control' | 'invoices';
    subdomain?: string;
  }): Promise<AgentBackupEntry[]> {
    const query = new URLSearchParams({ kind: filter.kind });
    if (filter.subdomain !== undefined) query.set('subdomain', filter.subdomain);
    return this.call('GET', `/v1/backups?${query.toString()}`);
  }

  private secret(): string | null {
    const value = this.config.get<string>('BACKUP_AGENT_SECRET')?.trim();
    return value && value.length >= BACKUP_AGENT_SECRET_MIN_LENGTH ? value : null;
  }

  private baseUrl(): string {
    const url = this.config.get<string>('BACKUP_AGENT_URL')?.trim();
    return (url && url !== '' ? url : BACKUP_AGENT_URL_DEFAULT).replace(/\/+$/, '');
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string>('BACKUP_AGENT_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw >= 1000 ? raw : 20_000;
  }

  /** DIE EINZIGE Stelle, die etwas an den Agent schickt. */
  private async call<T>(
    method: AgentMethod,
    pathWithQuery: string,
    payload?: unknown,
    secretsInBody: readonly string[] = [],
  ): Promise<T> {
    const secret = this.secret();
    if (secret === null) throw new BackupAgentNotConfiguredError();

    const body = payload === undefined ? '' : JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new BackupAgentRejectedError(413, 'Die Anfrage ist zu groß.');
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...authHeaders(secret, { method, pathWithQuery, body }),
    };
    if (body !== '') headers['content-type'] = 'application/json';

    const logPath = pathWithQuery.split('?')[0];
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${pathWithQuery}`, {
        method,
        headers,
        body: body === '' ? undefined : body,
        signal: AbortSignal.timeout(this.timeoutMs()),
        redirect: 'error',
      });
    } catch {
      this.logger.warn(`Sicherungs-Agent ${method} ${logPath}: nicht erreichbar`);
      throw new BackupAgentUnavailableError();
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      this.logger.warn(`Sicherungs-Agent ${method} ${logPath}: Antwort abgebrochen`);
      throw new BackupAgentUnavailableError();
    }
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      this.logger.warn(`Sicherungs-Agent ${method} ${logPath}: Status ${response.status}`);
      throw new BackupAgentRejectedError(
        response.status,
        agentMessage(parsed, secretsInBody),
      );
    }
    if (parsed === null) {
      this.logger.warn(`Sicherungs-Agent ${method} ${logPath}: Antwort ohne JSON`);
      throw new BackupAgentRejectedError(response.status, 'Unbrauchbare Antwort.');
    }
    return parsed as T;
  }
}

function agentMessage(parsed: unknown, secrets: readonly string[]): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const candidate = record['message'] ?? record['error'];
  if (typeof candidate !== 'string') return null;
  return scrub(candidate, secrets).slice(0, 300);
}
