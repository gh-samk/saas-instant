import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import {
  today,
  companyNameFingerprint,
  toDate,
} from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import {
  CoolifyConfigService,
  instanceHost,
  type InstanceContract,
} from '../coolify/coolify.config';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { METRICS_TIMEOUT_MS } from './instance.rules';

/** Die festen Fehlerarten. Nie eine durchgereichte Meldung — die kann alles enthalten. */
export type ErrorKind =
  | 'no_token'
  | 'timeout'
  | 'unreachable'
  | 'rejected'
  | 'inactive'
  | 'unexpected_response';

/** Was eine Instanz auf `GET <metricsPath>` antwortet. */
export interface MetricsResponse {
  datenbank: 'erreichbar' | 'gestoert';
  aktivePersonen: number | null;
  kreise: number | null;
  letzterEintragAm: string | null;
  letzteAnmeldungAm: string | null;
  appVersion: string;
  /**
   * `null` = nicht gemessen. Fehlt bei Instanzen auf älterem Stand ganz und
   * wird dann ebenfalls als „nicht gemessen" gelesen.
   */
  organisationsnameStimmt: boolean | null | undefined;
}

/** Injektionsmarke der Abruffunktion. */
export const METRICS_FETCH = 'METRICS_FETCH';

export interface FetchResult {
  day: string;
  fetched: number;
  successful: number;
  failed: number;
}

/**
 * Ein Abruf gegen eine Instanz — auswechselbar, damit Tests ohne Netz laufen.
 *
 * Über eine INJEKTIONSMARKE, nicht über einen Konstruktor-Vorgabewert ([K6]):
 * NestJS kennt Vorgabewerte nicht und kann einen Funktions-Typalias nicht
 * auflösen. Genau daran ist die Anwendung beim Start gescheitert.
 */
export type MetricsFetch = (
  url: string,
  token: string,
  timeoutMs: number,
) => Promise<{ ok: true; values: MetricsResponse } | { ok: false; kind: ErrorKind }>;

/**
 * Der Abdruck eines Organisationsnamens, wie ihn beide Seiten bilden ([W3]).
 *
 * DER NAME GEHT NICHT ÜBER DIE LEITUNG — in keine Richtung. Das CRM schickt
 * den Abdruck des Namens, den es erwartet; die Instanz antwortet mit ja oder
 * nein. So ist E3-20 („Organisationsname wird abgeglichen") erfüllt, ohne E3-3
 * („keine Namen") zu verletzen.
 *
 * Die Normalisierung liegt in `@saas-instant/shared`, damit beide Seiten
 * garantiert dieselbe benutzen. Liefen sie auseinander, meldete der Abgleich
 * für JEDE Instanz eine Abweichung — und ein Alarm, der immer angeht, wird
 * nicht mehr gelesen.
 */
export function nameAbdruck(name: string): string {
  return companyNameFingerprint(name, (value) =>
    createHash('sha256').update(value, 'utf8').digest('hex'),
  );
}

/**
 * PULL, NICHT PUSH — und das ist die eigentliche Aussage dieses Dienstes.
 *
 * Das CRM fragt die Kundeninstanzen ab; keine Instanz schickt etwas hierher.
 * Ein Ausfall des CRM berührt die Kundeninstanzen damit ÜBERHAUPT NICHT (E3-6):
 * Sie merken nichts davon, weil sie nichts zu tun haben. Ein Push-Modell hätte
 * die umgekehrte Eigenschaft — jede Kundeninstanz bräuchte eine Warteschlange,
 * einen Wiederholungsmechanismus und eine Meinung darüber, was passiert, wenn
 * das CRM eine Woche schweigt.
 *
 * FEHLSCHLÄGE WERDEN GESPEICHERT, NICHT VERSCHLUCKT (E3-7): Auch der
 * gescheiterte Versuch schreibt eine `Kennzahl`-Zeile — mit
 * `fetchSuccessful: false`, ohne Zahlen (NULL, nicht 0) und mit einer
 * FESTEN Fehlerart. Eine 0 an dieser Stelle wäre eine Falschaussage und löste
 * die Aufgabe „seit 45 Tagen kein Eintrag" aus, obwohl niemand etwas weiss.
 *
 * EINE HÄNGENDE INSTANZ BLOCKIERT DEN LAUF NICHT: Jede Abfrage hat eine
 * grosszügige, aber ENDLICHE Zeitgrenze, und ein Fehler bei einer Instanz
 * beendet den Durchgang nicht.
 */
@Injectable()
export class MetricsFetchService {
  private readonly logger = new Logger(MetricsFetchService.name);
  /** Schützt gegen Überlappung im selben Prozess, wie beim Zeitplan. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly coolifyConfig: CoolifyConfigService,
    @Inject(METRICS_FETCH) private readonly fetch: MetricsFetch,
  ) {}

  /** Täglich um 4 Uhr — nach dem Statuszeitplan um 3. */
  @Cron('0 0 4 * * *', { name: 'metrics-fetch' })
  async dailyRun(): Promise<void> {
    if (this.config.get<string>('CONTROL_METRICS_FETCH_ENABLED', 'ja') === 'nein') {
      this.logger.log('Kennzahlen-Abruf ist abgeschaltet.');
      return;
    }
    if (this.running) {
      this.logger.warn('Vorheriger Kennzahlen-Abruf ist noch nicht fertig.');
      return;
    }
    this.running = true;
    try {
      await this.executeFrom({ actor: 'metrics-fetch', userId: null });
    } finally {
      this.running = false;
    }
  }

  async executeFrom(trigger: {
    actor: string;
    userId: string | null;
  }): Promise<FetchResult> {
    const day = today();
    const contract = this.coolifyConfig.contract();
    // KEIN METRICS-PFAD DEKLARIERT = KEINE KENNZAHLEN. Der Endpunkt ist im
    // Instanz-Vertrag optional; eine Software ohne ihn wird nicht gefragt, und
    // das ist weder ein Fehlschlag noch ein Alarm: keine Zeile, kein Eintrag.
    const metricsPath = contract.metricsPath;
    if (metricsPath === null) {
      this.logger.log('Kennzahlen-Abruf übersprungen: die Software deklariert keinen metrics-Pfad.');
      return { day, fetched: 0, successful: 0, failed: 0 };
    }
    const instances = await this.prisma.instance.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        subdomain: true,
        metricsTokenEncrypted: true,
        // Nur der Name — daraus wird der Abdruck. Der Name selbst verlässt das
        // CRM nicht.
        company: { select: { name: true } },
      },
    });

    let successful = 0;
    let failed = 0;

    // NACHEINANDER, nicht parallel: Der Bestand ist klein, und ein Bündel
    // gleichzeitiger Abfragen gegen dieselbe Maschine wäre bei einer Störung
    // genau die Last, die sie nicht braucht.
    for (const instance of instances) {
      // EIN FEHLER BEI EINER INSTANZ DARF DIE ÜBRIGEN NICHT MITREISSEN ([K5]).
      //
      // Der Kommentar oben behauptete das schon, der Code hielt es nicht: Ohne
      // dieses `try` beendete eine einzige unsaubere Antwort — eine Zahl, die
      // die `Int`-Spalte sprengt, ein Schreibfehler, ein abgerissener
      // Verbindungspool — den GANZEN Tageslauf. Dann fielen E3-5 und E3-7 für
      // ALLE Instanzen aus, nicht nur für die auffällige, und die Zeitreihe
      // hatte für diesen Tag gar keine Zeile: kein Wert, kein Fehlschlag,
      // nichts. Genau die Stille, die dieses Modul melden soll.
      try {
        const result = await this.questionFrom(instance, { ...contract, metricsPath });
        await this.write(instance.id, day, result);
        if (result.ok) successful += 1;
        else failed += 1;
      } catch (exception) {
        failed += 1;
        const reason =
          exception instanceof Error ? exception.message : String(exception);
        this.logger.error(
          `Kennzahlen von ${instance.subdomain} konnten nicht verarbeitet ` +
            `werden: ${reason}. Der Lauf geht weiter.`,
        );
        // Auch der Fehlschlag beim SCHREIBEN wird festgehalten — sonst hiesse
        // „keine Zeile" wieder „nicht gemessen", und der Unterschied zwischen
        // „nicht erreicht" und „kaputt" ginge verloren. Scheitert selbst das,
        // bleibt es beim Logeintrag; der Lauf läuft trotzdem weiter.
        try {
          await this.write(instance.id, day, {
            ok: false,
            kind: 'unexpected_response',
          });
        } catch {
          this.logger.error(
            `Für ${instance.subdomain} liess sich nicht einmal der Fehlschlag ` +
              'festhalten. Die Instanz fehlt heute in der Zeitreihe.',
          );
        }
      }
    }

    const result: FetchResult = {
      day,
      fetched: instances.length,
      successful,
      failed,
    };
    this.logger.log(
      `Kennzahlen ${day}: ${instances.length} Instanzen, ${successful} ` +
        `erfolgreich, ${failed} fehlgeschlagen.`,
    );

    // Zusammenfassung, kein Nachweis — sie darf den Lauf nicht scheitern
    // lassen, dieselbe Abwägung wie beim Zeitplan ([H3]).
    try {
      await this.audit.log({
        userId: trigger.userId,
        actor: trigger.actor,
        action: AUDIT_ACTION.metricsFetch,
        objectType: 'Metric',
        objectId: null,
        afterValue: result,
      });
    } catch (exception) {
      const reason = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`Zusammenfassung nicht protokollierbar: ${reason}`);
    }
    return result;
  }

  private async questionFrom(
    instance: {
      subdomain: string;
      metricsTokenEncrypted: string | null;
      company: { name: string };
    },
    contract: InstanceContract & { metricsPath: string },
  ): Promise<
    { ok: true; values: MetricsResponse } | { ok: false; kind: ErrorKind }
  > {
    if (instance.metricsTokenEncrypted === null) {
      return { ok: false, kind: 'no_token' };
    }
    let token: string;
    try {
      token = this.crypto.decrypt(instance.metricsTokenEncrypted);
    } catch {
      // Nicht lesbar heisst nicht „kein Token": ein getauschter
      // CONTROL_CONFIG_KEY macht alle Geheimnisse unlesbar, und das muss
      // auffallen statt still als „nie eingerichtet" durchzugehen.
      this.logger.error(
        `Kennzahlen-Token von ${instance.subdomain} ist nicht entschlüsselbar. ` +
          'Wurde CONTROL_CONFIG_KEY getauscht?',
      );
      return { ok: false, kind: 'no_token' };
    }
    const fingerprint = nameAbdruck(instance.company.name);
    const url =
      `https://${instanceHost(contract, instance.subdomain)}${contract.metricsPath}` +
      `?nameAbdruck=${fingerprint}`;
    return this.fetch(url, token, METRICS_TIMEOUT_MS);
  }

  /**
   * Schreibt genau EINE Zeile je Instanz und Tag.
   *
   * `upsert` auf `[instanceId, datum]`: Ein zweiter Lauf am selben Tag
   * berichtigt die Zeile, statt die Zeitreihe zu verdoppeln. Damit ist der
   * Lauf idempotent — dieselbe Eigenschaft, die der Zeitplan aus Etappe 2 hat.
   */
  private async write(
    instanceId: string,
    day: string,
    result:
      | { ok: true; values: MetricsResponse }
      | { ok: false; kind: ErrorKind },
  ): Promise<void> {
    const date = toDate(day);
    const data = result.ok
      ? {
          activePersons: result.values.aktivePersonen,
          circles: result.values.kreise,
          lastEntryAt: asDay(result.values.letzterEintragAm),
          lastLoginAt: asDay(result.values.letzteAnmeldungAm),
          appVersion: result.values.appVersion,
          fetchSuccessful: true,
          errorKind: null,
          databaseState: result.values.datenbank,
          companyNameMatches: result.values.organisationsnameStimmt ?? null,
        }
      : {
          activePersons: null,
          circles: null,
          lastEntryAt: null,
          lastLoginAt: null,
          appVersion: null,
          fetchSuccessful: false,
          errorKind: result.kind,
          databaseState: null,
          // NULL, nicht false: „nicht gemessen" ist keine Abweichung.
          companyNameMatches: null,
        };

    await this.prisma.metric.upsert({
      where: { instanceId_date: { instanceId, date } },
      create: { instanceId, date, ...data },
      update: data,
    });

    await this.prisma.instance.update({
      where: { id: instanceId },
      data: {
        // Der letzte VERSUCH, nicht der letzte Erfolg — siehe Kommentar am
        // Feld im Schema.
        lastMetricsFetchAt: new Date(),
        ...(result.ok && result.values.appVersion
          ? { appVersion: result.values.appVersion }
          : {}),
      },
    });

    // DER ABSCHLUSS DER EINRICHTUNG, sobald die Instanz ihn erkennen lässt:
    // eine aktive Person oder überhaupt eine Organisation (nur dann kann der
    // Namensabgleich etwas anderes als `null` melden). Bedingt auf `null` —
    // ein einmal vermerkter Tag wird nicht verschoben.
    if (
      result.ok &&
      ((result.values.aktivePersonen ?? 0) > 0 ||
        (result.values.organisationsnameStimmt ?? null) !== null)
    ) {
      await this.prisma.instance.updateMany({
        where: { id: instanceId, setupCompletedAt: null },
        data: { setupCompletedAt: date },
      });
    }
  }

  /**
   * Die Kennzahlen EINER Instanz jetzt abrufen — der Knopf in der Karte.
   *
   * Ohne ihn erschienen App-Version und Zahlen einer neuen Instanz frühestens
   * am nächsten Morgen um 04:00. Derselbe Weg wie im Tageslauf (`questionFrom`,
   * `schreibe`), also dieselbe Zeile je Tag: Ein zweiter Klick berichtigt
   * sie, statt die Zeitreihe zu verdoppeln.
   *
   * `null`, wenn es keine AKTIVE Instanz gibt — dann gibt es nichts zu fragen.
   */
  async executeFromFor(
    companyId: string,
    trigger: { actor: string; userId: string | null },
  ): Promise<{ successful: boolean; errorKind: ErrorKind | null } | null> {
    const instance = await this.prisma.instance.findFirst({
      where: { companyId, status: 'active' },
      select: {
        id: true,
        subdomain: true,
        metricsTokenEncrypted: true,
        company: { select: { name: true } },
      },
    });
    if (instance === null) return null;

    const day = today();
    const contract = this.coolifyConfig.contract();
    const metricsPath = contract.metricsPath;
    if (metricsPath === null) return null;
    const result = await this.questionFrom(instance, { ...contract, metricsPath });
    await this.write(instance.id, day, result);
    await this.audit.log({
      userId: trigger.userId,
      actor: trigger.actor,
      action: AUDIT_ACTION.metricsFetch,
      objectType: 'Instance',
      objectId: instance.id,
      afterValue: {
        day,
        fetched: 1,
        successful: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
      },
    });
    return result.ok
      ? { successful: true, errorKind: null }
      : { successful: false, errorKind: result.kind };
  }
}

/** `YYYY-MM-DD` aus der Antwort — alles andere wird verworfen. */
function asDay(value: string | null): Date | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return toDate(value);
}

/**
 * Der echte HTTP-Abruf.
 *
 * ZEITGRENZE GROSSZÜGIG, ABER ENDLICH: Ohne `AbortController` hinge der ganze
 * Lauf an einer Instanz, die die Verbindung annimmt und dann schweigt — genau
 * der Fall, für den es diese Grenze gibt.
 */
export const getViaHttp: MetricsFetch = async (url, token, timeoutMs) => {
  const abort = new AbortController();
  const clock = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (response.status === 404) return { ok: false, kind: 'inactive' };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'rejected' };
    }
    if (!response.ok) return { ok: false, kind: 'unexpected_response' };
    const values = (await response.json()) as unknown;
    if (!isMetricsResponse(values)) {
      return { ok: false, kind: 'unexpected_response' };
    }
    return { ok: true, values };
  } catch (exception) {
    const aborted =
      exception instanceof Error &&
      (exception.name === 'AbortError' || exception.name === 'TimeoutError');
    return { ok: false, kind: aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(clock);
  }
};

/**
 * Prüft die Antwort einer fremden Instanz, bevor irgendetwas davon gespeichert
 * wird.
 *
 * Die Instanz ist zwar unsere eigene Software, aber die Antwort kommt über das
 * Netz. Was nicht der vereinbarten Form entspricht, wird als
 * `unerwartete_antwort` behandelt — nicht halb übernommen.
 */
export function isMetricsResponse(value: unknown): value is MetricsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    (w['datenbank'] === 'erreichbar' || w['datenbank'] === 'gestoert') &&
    isCountValue(w['aktivePersonen']) &&
    isCountValue(w['kreise']) &&
    isDayOrNull(w['letzterEintragAm']) &&
    isDayOrNull(w['letzteAnmeldungAm']) &&
    isVersion(w['appVersion']) &&
    isBooleanOrNull(w['organisationsnameStimmt'])
  );
}

/**
 * Ein Zählwert, der in die `Int`-Spalte passt ([K5]).
 *
 * `Number.isFinite` allein genügte nicht: `1e12` ist endlich und sprengt
 * `Int4` — der Schreibvorgang scheitert, und vorher riss er den ganzen
 * Tageslauf mit. Geprüft werden ganze Zahlen von 0 bis `Int4`-Obergrenze;
 * alles darüber ist keine Vereinsgrösse, sondern ein Fehler.
 */
export const INT4_MAX = 2_147_483_647;

export function isCountValue(x: unknown): boolean {
  return (
    x === null ||
    (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= INT4_MAX)
  );
}

/**
 * `true`, `false`, `null` — ODER GAR NICHT VORHANDEN.
 *
 * `undefined` ist ausdrücklich zulässig und wird zu `null` („nicht gemessen").
 * Eine Instanz, die noch auf einem älteren Stand läuft, kennt das Feld nicht;
 * ihre Antwort deshalb komplett zu verwerfen hiesse, dass nach dem Ausrollen
 * des CRM ALLE bestehenden Instanzen bis zu ihrem nächsten Deploy keine
 * Kennzahlen mehr liefern. Rückwärtskompatibilität schlägt hier Strenge — und
 * „nicht gemessen" ist eine wahre Aussage, keine halb übernommene.
 */
function isBooleanOrNull(x: unknown): boolean {
  return x === undefined || x === null || typeof x === 'boolean';
}

function isDayOrNull(x: unknown): boolean {
  return x === null || (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x));
}

/**
 * Die App-Version der Gegenseite ([W1]).
 *
 * DER EMPFÄNGER PRÜFT, NICHT DER ABSENDER. Dass `apps/api` heute eine saubere
 * Versionsnummer schickt, ist keine Zusicherung für alles, was jemals unter
 * dieser Adresse antwortet — eine fremde oder veraltete Instanz, ein
 * fehlgeleiteter Proxy, eine Fehlerseite. Ohne Grenze landete eine Million
 * Zeichen in `Kennzahl.appVersion` und von dort in `Instanz.appVersion`.
 */
export const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,32})?$/;

export function isVersion(x: unknown): boolean {
  return typeof x === 'string' && APP_VERSION_PATTERN.test(x);
}
