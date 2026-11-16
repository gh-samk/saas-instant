import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { VaultService } from '../vault/vault.service';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import { CoolifyConfigService } from '../coolify/coolify.config';
import {
  MailService,
  isRecipientRelated,
  classify,
  type ErrorClass,
} from '../mail/mail.service';
import { buildTransport, transportEnvironment } from '../mail/transport';
import type {
  OutboxSituation,
  OutboxRole,
} from './outbox.types';

export const ROLES: readonly OutboxRole[] = ['admin', 'instances'];

/** Länger wartet keine Probe; danach gilt der Server als nicht erreichbar. */
export const TIME_LIMIT_MS = 20_000;

/**
 * Die Klassen, die eine Probe überhaupt feststellen KANN.
 *
 * `verify()` baut die Verbindung auf, handelt TLS aus und meldet sich an —
 * es sendet aber keinen Umschlag. Eine Absenderabsage (`MAIL FROM`) oder ein
 * unbekannter Fehler beim echten Versand lässt sich damit weder bestätigen
 * noch widerlegen. Eine gelungene Probe darf deshalb nur Störungen dieser
 * drei Klassen für behoben erklären; alle anderen bleiben stehen, bis ein
 * echter Versand gelingt (dann setzt `MailService` seinen Fehler zurück).
 */
const PROBE_RECOGNIZABLE: ReadonlySet<ErrorClass> = new Set([
  'verbindung',
  'tls',
  'login',
]);

interface ProbeState {
  checkedAt: Date | null;
  disruptedSince: Date | null;
  errorClass: ErrorClass | null;
  notSetUp: boolean;
}

const EMPTY: ProbeState = {
  checkedAt: null,
  disruptedSince: null,
  errorClass: null,
  notSetUp: false,
};

/** Was eine Probe ergibt — oder dass es gar nichts zu prüfen gibt. */
export type ProbeResult =
  | { kind: 'successful' }
  | { kind: 'gescheitert'; errorClass: ErrorClass }
  | { kind: 'nicht_eingerichtet' }
  | { kind: 'nichts_zu_pruefen' };

/**
 * Der nächste Stand nach einer Probe. Rein, damit prüfbar.
 *
 * `gestoertSeit` bleibt bei wiederholtem Scheitern STEHEN: Die Frage im
 * Dashboard ist „seit wann", nicht „wann zuletzt".
 */
export function nextState(
  alt: ProbeState,
  result: ProbeResult,
  now: Date,
): ProbeState {
  switch (result.kind) {
    case 'nichts_zu_pruefen':
      return EMPTY;
    case 'nicht_eingerichtet':
      return { ...EMPTY, checkedAt: now, notSetUp: true };
    case 'successful':
      return { ...EMPTY, checkedAt: now };
    case 'gescheitert':
      return {
        checkedAt: now,
        disruptedSince: alt.disruptedSince ?? now,
        errorClass: result.errorClass,
        notSetUp: false,
      };
  }
}

/** Was eine Probe braucht — genau die zwei Methoden von nodemailer. */
export interface ProbeTransport {
  verify(): Promise<unknown>;
  close(): void;
}

/**
 * DER POSTAUSGANG ALS AUFGABE IM DASHBOARD.
 *
 * Anlass (12.09.2026): Das Passwort des Postfachs wurde versehentlich
 * geändert. Danach ging keine einzige Mail mehr hinaus — weder aus der
 * Verwaltung noch aus der eben angelegten Instanz —, und bemerkt hat es
 * niemand, bis Einladungen ausblieben. Die Verwaltung wusste es längst:
 * `MailService` merkt sich den letzten Fehler. Nur gezeigt hat es ihn
 * nirgends.
 *
 * ZWEI QUELLEN, EIN STAND:
 * 1. Der echte Versand — `MailService.versandStand()`, unverändert. Er ist
 *    die Wahrheit, kommt aber nur, wenn gerade etwas versendet wird.
 * 2. Eine Probe — `verify()`: verbinden, TLS, anmelden, KEINE Mail. Einmal
 *    beim Start und dann stündlich, damit eine Störung auch in einer Woche
 *    ohne Versand auffällt. Und auf Knopfdruck aus dem Dashboard, damit man
 *    nach der Behebung nicht eine Stunde warten muss.
 *
 * NUR IM SPEICHER, wie `MailService.letzterFehler` und aus demselben Grund:
 * Das ist eine Betriebsanzeige, kein Nachweis. Nach einem Neustart prüft die
 * Startprobe sofort neu.
 *
 * Empfängerabsagen zählen NICHT: Sie sagen etwas über eine Adresse, nicht
 * über den Postausgang (`istEmpfaengerbezogen`).
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxService.name);
  private readonly state: Record<OutboxRole, ProbeState> = {
    admin: EMPTY,
    instances: EMPTY,
  };
  private run: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly coolifyConfig: CoolifyConfigService,
    // Optional: die Probe selbst liest keine Kundendaten, wartet aber wie alle
    // Hintergrundläufe auf das Entsperren.
    @Optional() private readonly vault?: VaultService,
  ) {}

  private active(): boolean {
    return this.config.get<string>('CONTROL_OUTBOX_PROBE_ENABLED', 'ja') !== 'nein';
  }

  /** Startprobe — ohne den Start aufzuhalten. */
  onApplicationBootstrap(): void {
    if (!this.active()) return;
    const start = (): void => {
      void this.checkAll().catch((error: unknown) =>
        this.logger.error(`Startprobe des Postausgangs gescheitert: ${String(error)}`),
      );
    };
    if (this.vault) this.vault.onUnlocked(start);
    else start();
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'postausgang-probe' })
  async hourly(): Promise<void> {
    if (!this.active()) return;
    await this.checkAll();
  }

  /**
   * Prüft beide Postausgänge und gibt den neuen Stand zurück.
   *
   * Läuft schon eine Prüfung, wird auf DIESE gewartet statt eine zweite
   * anzustoßen — ein Doppelklick soll nicht zwei Anmeldungen am Mailserver
   * auslösen.
   */
  async checkAll(): Promise<OutboxSituation[]> {
    this.run ??= this.execute().finally(() => {
      this.run = null;
    });
    await this.run;
    return this.situation();
  }

  private async execute(): Promise<void> {
    for (const role of ROLES) {
      const result = await this.probe(role);
      this.state[role] = nextState(this.state[role], result, new Date());
    }
  }

  private async probe(role: OutboxRole): Promise<ProbeResult> {
    const transport = this.probeTransport(role);
    if (transport === 'nicht_eingerichtet' || transport === 'nichts_zu_pruefen') {
      return { kind: transport };
    }
    try {
      await withTimeLimit(transport.verify(), this.timeLimitMs());
      return { kind: 'successful' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const errorClass = classify(error, reason);
      // Wortlaut nur ins Log, wie im MailService. Ein Passwort steht in
      // keiner SMTP-Antwort.
      this.logger.warn(`Postausgang (${role}) gestört [${errorClass}]: ${reason}`);
      return { kind: 'gescheitert', errorClass };
    } finally {
      transport.close();
    }
  }

  /** Überschreibbar für Tests; im Betrieb unverändert. */
  protected timeLimitMs(): number {
    return TIME_LIMIT_MS;
  }

  /**
   * Der Transport, mit dem geprüft wird — DERSELBE Aufbau wie beim echten
   * Versand, sonst bewiese die Probe etwas anderes als das, was scheitert.
   *
   * Überschreibbar für Tests (dort ohne Netz).
   */
  protected probeTransport(
    role: OutboxRole,
  ): ProbeTransport | 'nicht_eingerichtet' | 'nichts_zu_pruefen' {
    if (role === 'admin') {
      // Ohne SMTP_HOST schreibt der MailService absichtlich in den
      // JSON-Transport (Entwicklung) — da gibt es nichts zu prüfen.
      return transportEnvironment(this.config).configured
        ? buildTransport(this.config)
        : 'nichts_zu_pruefen';
    }
    const config = this.coolifyConfig.read();
    // Ohne Coolify legt die Verwaltung keine Instanzen an; ein fehlender
    // Instanz-Postausgang ist dann kein Mangel.
    if (config === null) return 'nichts_zu_pruefen';
    const smtp = config.instanceSmtp;
    if (smtp === null) return 'nicht_eingerichtet';
    return nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port),
      secure: smtp.port === '465',
      requireTLS: true,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  /** Der Stand beider Postausgänge — ohne etwas zu prüfen. */
  situation(): OutboxSituation[] {
    return ROLES.map((role) => this.situationFor(role));
  }

  private situationFor(role: OutboxRole): OutboxSituation {
    const probe = this.state[role];
    const checkedAt = probe.checkedAt?.toISOString() ?? null;
    const withoutDisruption = { checkedAt, disruptedSince: null, errorClass: null, detectedBy: null };

    // Der Versand gehört zur Verwaltung: Der MailService sendet mit SMTP_*.
    const send = role === 'admin' ? this.sendError() : null;
    const sendApplies =
      send !== null &&
      (probe.checkedAt === null ||
        send.timestamp > probe.checkedAt ||
        !PROBE_RECOGNIZABLE.has(send.errorClass) ||
        probe.disruptedSince !== null);
    if (send !== null && sendApplies) {
      const since =
        probe.disruptedSince !== null && probe.disruptedSince < send.timestamp
          ? probe.disruptedSince
          : send.timestamp;
      return {
        role,
        state: 'gestoert',
        checkedAt,
        disruptedSince: since.toISOString(),
        errorClass: send.errorClass,
        detectedBy: 'send',
      };
    }
    if (probe.notSetUp) {
      return { role, state: 'nicht_eingerichtet', ...withoutDisruption };
    }
    if (probe.disruptedSince !== null) {
      return {
        role,
        state: 'gestoert',
        checkedAt,
        disruptedSince: probe.disruptedSince.toISOString(),
        errorClass: probe.errorClass,
        detectedBy: 'probe',
      };
    }
    return {
      role,
      state: probe.checkedAt === null ? 'ungeprueft' : 'in_ordnung',
      ...withoutDisruption,
    };
  }

  private sendError(): { timestamp: Date; errorClass: ErrorClass } | null {
    const error = this.mail.sendState().lastError;
    if (error === null || isRecipientRelated(error.errorClass)) return null;
    return { timestamp: new Date(error.timestamp), errorClass: error.errorClass };
  }
}

async function withTimeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('Zeitüberschreitung (timeout) bei der Probe'), {
            code: 'ETIMEDOUT',
          }),
        ),
      ms,
    );
    // Eine hängende Probe soll keinen Prozess am Beenden hindern.
    timer.unref();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
