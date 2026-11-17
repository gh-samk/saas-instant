import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Mail,
  RefreshCw,
  Server,
} from 'lucide-react';
import { Card, Button, EmptyState, Skeleton, useToast } from '@saas-instant/ui';
import { Field } from './DetailBlock';
import { InstanceCreateDialog } from './InstanceCreateDialog';
import { InstanceArchiveDialog } from './InstanceArchiveDialog';
import { InstanceBackups } from './InstanceBackups';
import { InstanceStatusBadge } from './InstanceStatusBadge';
import { errorText } from '../lib/api-client';
import {
  fetchInvitationLink,
  fetchInstance,
  checkInstanceReachability,
  fetchMetrics,
  sendInvitationLink,
  discardInstanceCreation,
  type InstanceDetail,
  type InstanceMetrics,
  type InstanceMetricsPoint,
  type SecondFactorEvidence,
} from '../lib/api';
import { ApiError } from '../lib/api-client';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { HANGS_FIXED_MINUTES } from '../lib/instance-status';
import { instanceHost, instanceUrl } from '../lib/instance-address';
import { deletionDay } from '@saas-instant/shared';
import { formatDate } from '../utils/date';
import { formatSize } from '../utils/size';
import { runtimeInWords, minutesSince, beforeTimespan } from '../utils/timespan';
import { t, useT } from '../i18n';

/** Wie oft ein laufender Vorgang neu abgefragt wird. */
const POLL_INTERVAL_MS = 5_000;
/** Wie oft die Laufzeitangabe neu gerechnet wird. */
const RUNTIME_INTERVAL_MS = 30_000;

/** Die Zustände, in denen serverseitig noch etwas arbeitet. */
function stillRunning(status: InstanceDetail['status']): boolean {
  return status === 'provisioning' || status === 'stopped';
}

/**
 * Die Instanz-Karte der Organisations-Detailseite.
 *
 * SIE FRAGT SICH SELBST NEU AB, statt einen Dialog minutenlang offen zu halten.
 * Das Anlegen dauert laut Auftrag Minuten, nicht Sekunden; der Dialog schließt
 * deshalb, sobald der Server die Anfrage angenommen hat, und diese Karte
 * übernimmt. Damit beantwortet sich „was, wenn ich die Seite verlasse und
 * zurückkomme" von selbst: Es gibt keinen lokal gespeicherten Fortschritt, der
 * verloren gehen könnte — beim erneuten Öffnen wird derselbe serverseitige
 * Stand geholt.
 *
 * ES GIBT KEINEN ENUMWERT `fehlgeschlagen`. Scheitert die Erstellung, bleibt
 * der Status auf `wird_erstellt` und der Grund steht im Klartext in `meldung`;
 * bleibt bei der Archivierung etwas offen, steht er nach `archiviert` ebenfalls
 * dort. `meldung` wird deshalb in BEIDEN Fällen gezeigt — im laufenden Übergang
 * und im Endzustand. Fehlte eine der beiden Stellen, entstünde genau der stille
 * Halbzustand, den E3-12 ausschließt.
 *
 * KEIN „ERNEUT VERSUCHEN", KEIN „LÖSCHEN", KEIN „WIEDERHERSTELLEN". Es gibt
 * genau zwei Schreibvorgänge gegen eine Kundeninstanz: anlegen und archivieren
 * (R1). Wo die Versuchung bestünde, einen dritten Knopf zu bauen, steht
 * stattdessen eine Zeile, die auf Coolify verweist. Der einzige „Erneut
 * versuchen"-Knopf hier lädt die Instanzdaten neu und schreibt nichts.
 */
export function InstanceCard({
  companyId,
  companyName,
  contactEmail = null,
  totpPossible,
  onHistoryChanged,
  createRequested = false,
  onCreateRequestHandled,
}: {
  companyId: string;
  companyName: string;
  /**
   * Nur zur ANZEIGE, an wen der Link ginge. Der Server nimmt die Adresse aus
   * dem Datensatz, nie von hier.
   */
  contactEmail?: string | null;
  /** Ohne Authenticator-App gibt es beim Nachweis nur den Passwortweg. */
  totpPossible: boolean;
  /** Archivieren schreibt eine Systemnotiz — der Verlauf muss nachziehen. */
  onHistoryChanged?: () => void;
  /**
   * Von außen angeforderter Anlegen-Dialog (Schrittliste im Überblick). Gilt
   * nur, solange es noch keine Instanz gibt — bei einer vorhandenen wäre der
   * Dialog eine Einladung zum zweiten Anlegen.
   */
  createRequested?: boolean;
  /** Meldet zurück, dass die Anforderung gelesen wurde (sie wird dann gelöscht). */
  onCreateRequestHandled?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  // `== null` statt `=== null` an der Fallunterscheidung weiter unten: Der
  // Server schickt bei fehlender Instanz einen LEEREN Körper. `apiFetch` macht
  // daraus inzwischen `null` (siehe dort), aber die Karte prüft trotzdem
  // lose — ein zweiter Riegel kostet ein Zeichen, und der erste hat gefehlt.
  const [instance, setInstance] = useState<InstanceDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Der Dialog kann aus dem Überblick angefordert werden: Dann wechselt der
  // Reiter, und der Auslöser ist weg. Der Fokus geht beim Schließen an den
  // Anlegen-Knopf dieser Karte.
  const createButtonId = `instance-create-${companyId}`;
  /**
   * Der Einrichtungslink wird NICHT mit der Karte geladen ([A.7]).
   *
   * Er trägt das Geheimnis, mit dem man auf der Kundeninstanz Administrator
   * wird. Er kommt erst auf ausdrückliches Verlangen und gegen einen zweiten
   * Faktor herüber, und er bleibt nur im Speicher dieser Ansicht.
   */
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkDialogError, setLinkDialogError] = useState<string>();
  // Versand per Mail — derselbe Nachweis wie beim Anzeigen, eigener Dialog,
  // damit nicht die eine Handlung mit dem Wortlaut der anderen bestätigt wird.
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [sendDialogError, setSendDialogError] = useState<string>();
  const [metricsLoading, setMetricsLoading] = useState(false);
  // [Review B3] Wechselt die Organisation, gehört der Link der vorigen nicht
  // mehr auf den Schirm — auch nicht für einen Wimpernschlag. Die Route
  // /companies/:id verwendet dieses Element bei ID-Wechsel wieder; ohne
  // diesen Reset stünde unter dem Namen von B der Einrichtungslink von A.
  useEffect(() => {
    setInvitationLink(null);
    setLinkDialogOpen(false);
    setLinkDialogError(undefined);
  }, [companyId]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Reine Anzeigeuhr für „läuft seit …". Kein Sekundenzähler.
  const [, setTick] = useState(0);

  const lives = useRef(true);
  useEffect(() => {
    lives.current = true;
    return () => {
      lives.current = false;
    };
  }, []);

  const load = useCallback(
    async (withSkeleton: boolean) => {
      if (withSkeleton) {
        setLoaded(false);
        setLoadError(null);
      }
      try {
        const state = await fetchInstance(companyId);
        if (!lives.current) return;
        setInstance(state);
        setLoadError(null);
      } catch (f) {
        if (!lives.current) return;
        // Ein gescheitertes Nachfragen darf einen bereits sichtbaren Stand
        // nicht wegräumen — sonst flackerte die Karte bei jedem Aussetzer.
        if (withSkeleton) {
          setLoadError(
            errorText(f, t('components.instanceCard.text')),
          );
        }
      } finally {
        if (lives.current) setLoaded(true);
      }
    },
    [companyId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Angeforderter Anlegen-Dialog: erst nach dem Laden entscheiden, weil erst
  // dann feststeht, ob es schon eine Instanz gibt.
  useEffect(() => {
    if (!createRequested || !loaded) return;
    if (instance == null && loadError === null) setCreateOpen(true);
    onCreateRequestHandled?.();
  }, [createRequested, loaded, instance, loadError, onCreateRequestHandled]);

  // Solange serverseitig etwas läuft, fragt die Karte nach — und hört auf,
  // sobald der Zustand steht oder die Seite verlassen wird.
  const status = instance?.status;
  useEffect(() => {
    if (status === undefined || !stillRunning(status)) return;
    const clock = setInterval(() => void load(false), POLL_INTERVAL_MS);
    return () => clearInterval(clock);
  }, [status, load]);

  useEffect(() => {
    if (status === undefined || !stillRunning(status)) return;
    const clock = setInterval(() => setTick((n) => n + 1), RUNTIME_INTERVAL_MS);
    return () => clearInterval(clock);
  }, [status]);

  /**
   * Holt den Einrichtungslink gegen einen zweiten Faktor.
   *
   * Ein `401` heisst hier zweierlei: Nachweis noetig ODER Nachweis falsch.
   * Unterschieden wird daran, ob gerade einer mitgeschickt wurde — dasselbe
   * Vorgehen wie in der ZahlungsdatenKarte.
   */
  async function showInvitationLink(evidence?: SecondFactorEvidence) {
    setLinkLoading(true);
    try {
      const { invitationLink: link } = await fetchInvitationLink(
        companyId,
        evidence,
      );
      setInvitationLink(link);
      setLinkDialogOpen(false);
      setLinkDialogError(undefined);
      if (link === null) {
        toast.show(t('components.instanceCard.text2'));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && evidence) {
        setLinkDialogError(
          evidence.totpCode !== undefined
            ? t('components.instanceCard.text3')
            : t('components.instanceCard.text4'),
        );
        return;
      }
      setLinkDialogError(
        errorText(e, t('components.instanceCard.text5')),
      );
    } finally {
      setLinkLoading(false);
    }
  }

  /**
   * Schickt den Einrichtungslink an die Ansprechpartnerin — gegen Nachweis.
   *
   * Die Rückmeldung nennt, WAS passiert ist, statt „hat geklappt/nicht
   * geklappt": ohne Adresse, ohne offenen Link, Versand gescheitert — drei
   * verschiedene nächste Schritte.
   */
  async function sendLink(evidence: SecondFactorEvidence) {
    setSendLoading(true);
    try {
      const result = await sendInvitationLink(companyId, evidence);
      setSendDialogOpen(false);
      setSendDialogError(undefined);
      if (result.sent) {
        toast.show(t('components.instanceCard.text6', { email: result.email }));
      } else if (result.reason === 'no_address') {
        toast.show(
          t('components.instanceCard.text7') +
            t('components.instanceCard.text8'),
          'error',
        );
      } else if (result.reason === 'no_link') {
        toast.show(t('components.instanceCard.text2'));
        void load(false);
      } else {
        toast.show(
          t('components.instanceCard.text9'),
          'error',
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSendDialogError(
          evidence.totpCode !== undefined
            ? t('components.instanceCard.text3')
            : t('components.instanceCard.text4'),
        );
        return;
      }
      setSendDialogError(
        errorText(e, t('components.instanceCard.text10')),
      );
    } finally {
      setSendLoading(false);
    }
  }

  /** Kennzahlen jetzt statt um 04:00 — danach die Karte neu laden. */
  async function metricsNow() {
    setMetricsLoading(true);
    try {
      const result = await fetchMetrics(companyId);
      if (result === null) {
        toast.show(t('components.instanceCard.text11'));
      } else if (result.successful) {
        toast.show(t('components.instanceCard.text12'));
      } else {
        toast.show(
          t('components.instanceCard.text13'),
          'error',
        );
      }
      await load(false);
    } catch (e) {
      toast.show(errorText(e, t('components.instanceCard.text14')), 'error');
    } finally {
      setMetricsLoading(false);
    }
  }

  /**
   * Verwirft eine gescheiterte Erstellung und macht den Weg frei.
   *
   * OHNE RUECKFRAGE-DIALOG, anders als beim Archivieren: Es geht nichts
   * verloren, was es je gab. Der Server prueft die Bedingungen noch einmal
   * und antwortet mit 409, wenn in Coolify doch etwas steht — dann sagt die
   * Meldung genau das.
   */
  async function discard() {
    try {
      await discardInstanceCreation(companyId);
      setInstance(null);
      toast.show(t('components.instanceCard.text15'));
      await load(true);
    } catch (error) {
      toast.show(
        errorText(error, t('components.instanceCard.text16')),
        'error',
      );
    }
  }

  /**
   * „Erneut prüfen": fragt die Instanz einmal. Antwortet sie, steht sie
   * danach auf `aktiv`; sonst bleibt alles, wie es ist.
   */
  async function checkAgain() {
    try {
      const { erreichbar } = await checkInstanceReachability(companyId);
      toast.show(
        erreichbar
          ? t('components.instanceCard.text17')
          : t('components.instanceCard.text18'),
        erreichbar ? 'success' : 'error',
      );
      await load(true);
    } catch (error) {
      toast.show(errorText(error, t('components.instanceCard.text19')), 'error');
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast.show(t('components.instanceCard.text20'));
    } catch {
      toast.show(t('components.instanceCard.text21'), 'error');
    }
  }

  return (
    <Card className="mt-6 p-6" id="instanz">
      {!loaded ? (
        <div aria-busy="true">
          <Skeleton className="mb-4 h-6 w-40" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : loadError !== null ? (
        <>
          <h2 className="mb-4 text-lg font-semibold text-text">{t('components.instanceCard.heading')}</h2>
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          {/* Lädt nur nach. Es wird nichts geschrieben. */}
          <Button variant="secondary" onClick={() => void load(true)}>
            {t('components.instanceCard.button')}</Button>
        </>
      ) : instance == null ? (
        <>
          <h2 className="mb-4 text-lg font-semibold text-text">{t('components.instanceCard.heading')}</h2>
          <EmptyState
            Icon={Server}
            title={t('components.instanceCard.title')}
            notice={t('components.instanceCard.notice')}
            action={
              <Button id={createButtonId} onClick={() => setCreateOpen(true)}>{t('components.instanceCard.button2')}</Button>
            }
          />
        </>
      ) : (
        <>
        <InstanceContent
          instance={instance}
          companyName={companyName}
          invitationLink={invitationLink}
          onInvitationLinkRequest={() => {
            setLinkDialogError(undefined);
            setLinkDialogOpen(true);
          }}
          contactEmail={contactEmail}
          onInvitationLinkSend={() => {
            setSendDialogError(undefined);
            setSendDialogOpen(true);
          }}
          metricsLoading={metricsLoading}
          onMetricsFetch={() => void metricsNow()}
          onArchive={() => setArchiveOpen(true)}
          onCopy={(link) => void copy(link)}
          onDiscard={() => void discard()}
          onAgainCheck={() => void checkAgain()}
        />
        {/* Sicherungen und Wiederherstellung als NEUE Instanz. Nur für eine
            laufende Instanz sinnvoll; nichts davon löscht (R1). */}
        {instance.status === 'active' && (
          <InstanceBackups
            instanceId={instance.id}
            subdomain={instance.subdomain}
            totpPossible={totpPossible}
            onAdopted={() => void load(false)}
          />
        )}
        </>
      )}

      <InstanceCreateDialog
        open={createOpen}
        companyId={companyId}
        companyName={companyName}
        returnFocusTo={() => document.getElementById(createButtonId)}
        onClose={() => setCreateOpen(false)}
        onCreated={(newValue) => {
          // Der Dialog schließt SOFORT — der minutenlange Teil läuft im
          // Hintergrund, sichtbar in dieser Karte.
          setCreateOpen(false);
          setInstance(newValue);
          toast.show(t('components.instanceCard.text22'));
          // Die Kopfzeile der Organisation richtet ihre Hauptaktion danach
          // aus, ob es schon eine Instanz gibt.
          onHistoryChanged?.();
        }}
      />

      {instance !== null && (
        <InstanceArchiveDialog
          open={archiveOpen}
          companyId={companyId}
          companyName={companyName}
          subdomain={instance.subdomain}
          onClose={() => setArchiveOpen(false)}
          onArchived={(newValue) => {
            setArchiveOpen(false);
            setInstance(newValue);
            toast.show(t('components.instanceCard.text23'));
            onHistoryChanged?.();
          }}
        />
      )}

      {/* [A.7] Wer diesen Link hat, wird auf der Kundeninstanz Administrator.
          Deshalb derselbe Nachweis wie bei den Zahlungsdaten — und derselbe
          Hinweis, dass der Zugriff protokolliert wird. */}
      <SecondFactorEvidenceDialog
        open={linkDialogOpen}
        title={t('components.instanceCard.title2')}
        declaration={
          t('components.instanceCard.declaration') +
          t('components.instanceCard.declaration2')
        }
        totpPossible={totpPossible}
        loading={linkLoading}
        error={linkDialogError}
        onCancel={() => {
          setLinkDialogOpen(false);
          setLinkDialogError(undefined);
        }}
        onConfirm={(evidence) => void showInvitationLink(evidence)}
      />

      <SecondFactorEvidenceDialog
        open={sendDialogOpen}
        title={t('components.instanceCard.title3')}
        declaration={
          t('components.instanceCard.declaration3', { value: contactEmail ?? t('components.instanceCard.noAddressFallback') }) +
          t('components.instanceCard.declaration4') +
          t('components.instanceCard.declaration5')
        }
        totpPossible={totpPossible}
        loading={sendLoading}
        error={sendDialogError}
        onCancel={() => {
          setSendDialogOpen(false);
          setSendDialogError(undefined);
        }}
        onConfirm={(evidence) => void sendLink(evidence)}
      />
    </Card>
  );
}

/** Kopfbereich plus der zum Status passende Rumpf. */
function InstanceContent({
  instance,
  companyName,
  invitationLink,
  onInvitationLinkRequest,
  contactEmail,
  onInvitationLinkSend,
  metricsLoading,
  onMetricsFetch,
  onArchive,
  onCopy,
  onDiscard,
  onAgainCheck,
}: {
  instance: InstanceDetail;
  companyName: string;
  invitationLink: string | null;
  onInvitationLinkRequest: () => void;
  contactEmail: string | null;
  onInvitationLinkSend: () => void;
  metricsLoading: boolean;
  onMetricsFetch: () => void;
  onArchive: () => void;
  onCopy: (link: string) => void;
  onDiscard: () => void;
  onAgainCheck: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">{t('components.instanceCard.heading')}</h2>
          {instanceUrl(instance.subdomain) === null ? (
            <span className="mt-1 block break-words text-sm text-text">
              {instance.subdomain}
            </span>
          ) : (
          <a
            href={instanceUrl(instance.subdomain) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex max-w-full items-center gap-1 text-sm text-primaer underline underline-offset-2 hover:text-primaer-hover"
          >
            {/* `break-words` statt `break-all`: eine Subdomain bricht dann am
                Bindestrich statt mitten im Wort. */}
            <span className="min-w-0 break-words">
              {instanceHost(instance.subdomain)}
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <InstanceStatusBadge status={instance.status} />
          {/* Nur bei „aktiv": bei einem laufenden Vorgang gibt es nichts zu
              archivieren, bei „archiviert" nichts mehr. */}
          {instance.status === 'active' && (
            <Button variant="secondary" onClick={onArchive}>
              {t('components.instanceCard.button3')}</Button>
          )}
        </div>
      </div>

      {stillRunning(instance.status) ? (
        <Transition
          instance={instance}
          onDiscard={onDiscard}
          onAgainCheck={onAgainCheck}
        />
      ) : instance.status === 'archived' ? (
        <Archived instance={instance} />
      ) : (
        <Active
          instance={instance}
          companyName={companyName}
          invitationLink={invitationLink}
          onInvitationLinkRequest={onInvitationLinkRequest}
          contactEmail={contactEmail}
          onInvitationLinkSend={onInvitationLinkSend}
          metricsLoading={metricsLoading}
          onMetricsFetch={onMetricsFetch}
          onCopy={onCopy}
        />
      )}
    </>
  );
}

/**
 * `wird_erstellt` und `gestoppt` — der laufende Vorgang.
 *
 * Ab `HAENGT_FEST_MINUTEN` ohne Abschluss wird die Anzeige Einwand-rot. Das ist
 * der EINZIGE rote Zustand dieser Karte, und er ist es im engen Wortsinn: Die
 * Ersteinrichtung kann nicht abgeschlossen werden, bis das geklärt ist.
 */
/**
 * Der Ausweg aus der Sackgasse.
 *
 * Er ruft KEINEN Schreibvorgang gegen Coolify auf — der Server laesst die
 * Route nur zu, wenn dort nichts entstanden ist. Verworfen wird eine
 * CRM-Zeile ueber einen Vorgang, der nie stattgefunden hat.
 *
 * WARUM ES IHN BRAUCHT: `Instanz.organisationId` ist unique. Ohne ihn bleibt
 * nach einem gescheiterten ersten Coolify-Aufruf eine Zeile auf
 * `wird_erstellt` stehen, die auf nichts zeigt — und die Organisation bekommt
 * nie eine Instanz. Die Route gab es seit [W4]; die Oberflaeche kannte sie
 * nicht.
 */
function DiscardButton({
  instance,
  onDiscard,
}: {
  instance: InstanceDetail;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-3">
      {/* ZWEI FÄLLE, ZWEI SÄTZE. Hier stand immer „dort ist nichts
          entstanden" — auch als in Coolify die halb angelegte Anwendung
          stand. Der Server lehnte dann ab, und der Satz unter dem Knopf war
          falsch (gemeldet am 11.09.2026). */}
      {instance.coolifyCreated && (
        <p className="mb-2 text-sm text-text">
          {t('components.instanceCard.text24')}{' '}
          <code className="text-sm">{instance.subdomain}</code>{t('components.instanceCard.text25')}</p>
      )}
      <Button variant="secondary" onClick={onDiscard}>
        {t('components.instanceCard.button4')}</Button>
      <p className="mt-1.5 text-sm text-leise">
        {instance.coolifyCreated
          ? t('components.instanceCard.text26')
          : t('components.instanceCard.text27')}
      </p>
    </div>
  );
}

/**
 * Ist der Aufbau GESCHEITERT — und zwar so, dass in Coolify nichts steht?
 *
 * Der Server entscheidet das noch einmal selbst und streng (`coolifyAnwendungId`
 * muss leer sein); hier geht es nur darum, den Knopf nicht anzubieten, wo er
 * ohnehin abgewiesen wuerde. Das Erkennungsmerkmal ist der Wortlaut, mit dem
 * `instanz-aufbau.service.ts` scheitert — es gibt bewusst keinen Enumwert
 * `fehlgeschlagen`.
 */
function provisioningFailed(instance: InstanceDetail): boolean {
  return (
    instance.status === 'provisioning' &&
    (instance.message ?? '').startsWith(t('components.instanceCard.text28'))
  );
}

/**
 * Ausgerollt, aber noch nicht erreichbar — KEIN Fehlschlag.
 *
 * Das Präfix setzt `instanz-aufbau.service.ts` (`ERREICHBARKEIT_AUSSTEHEND`).
 * Bis zum 11.09.2026 war dieser Fall ein Fehlschlag ohne Ausweg: Die Instanz
 * lief, blieb aber auf `wird_erstellt`, und die Karte behauptete „läuft im
 * Hintergrund weiter".
 */
function reachabilityPending(instance: InstanceDetail): boolean {
  return (
    instance.status === 'provisioning' &&
    (instance.message ?? '').startsWith(t('components.instanceCard.text29'))
  );
}

function AgainCheckButton({ onAgainCheck }: { onAgainCheck: () => void }) {
  const t = useT();
  return (
    <div className="mt-3">
      <Button variant="secondary" onClick={onAgainCheck}>
        {t('components.instanceCard.button5')}</Button>
      <p className="mt-1.5 text-sm text-leise">
        {t('components.instanceCard.text30')}</p>
    </div>
  );
}

/** Die Meldung ohne ihr Präfix — die Überschrift sagt es schon. */
function withoutPrefix(message: string | null, prefix: string): string {
  const text = message ?? '';
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
}

function Transition({
  instance,
  onDiscard,
  onAgainCheck,
}: {
  instance: InstanceDetail;
  onDiscard: () => void;
  onAgainCheck: () => void;
}) {
  const t = useT();
  // ===================================================================
  // DIE BEIDEN ENDZUSTÄNDE ZUERST — sie laufen NICHT
  // ===================================================================
  //
  // Gemeldet am 12.09.2026: Über einem Aufbau, der seit einer Stunde
  // gescheitert war, stand „Läuft seit 56 Minuten ohne Abschluss … Diese
  // Karte aktualisiert sich automatisch". Und schon vor der 15-Minuten-Grenze
  // drehte sich das Symbol neben „Die Instanz wird erstellt. … Läuft seit 6
  // Minuten" — obwohl nichts mehr lief. Beides behauptete einen Vorgang, den
  // es nicht gab.
  //
  // „Läuft" und „dauert ungewöhnlich lange" gelten deshalb nur noch für
  // einen Aufbau, der wirklich läuft. Gescheitert und „ausgerollt, antwortet
  // noch nicht" sind Endzustände mit eigener Anzeige und eigenem Ausweg.
  if (provisioningFailed(instance)) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-einwand-rahmen bg-einwand-bg p-4"
      >
        <AlertCircle
          className="mt-0.5 h-5 w-5 shrink-0 text-einwand-text"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-einwand-text">
            {t('components.instanceCard.text31')}</p>
          <p className="mt-0.5 text-sm text-einwand-text">
            {withoutPrefix(instance.message, t('components.instanceCard.text28'))}
          </p>
          {/* Kein „Erneut versuchen": ein Neustart wäre eine dritte
              Schreiboperation gegen Coolify (R1). Der Ausweg ist Verwerfen. */}
          <DiscardButton instance={instance} onDiscard={onDiscard} />
        </div>
      </div>
    );
  }
  if (reachabilityPending(instance)) {
    return (
      <div
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-4"
      >
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-bedenken-text"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">
            {t('components.instanceCard.text32')}</p>
          <AgainCheckButton onAgainCheck={onAgainCheck} />
        </div>
      </div>
    );
  }

  const created = instance.status === 'provisioning';
  // DIE LAUFZEIT GILT NUR FÜR DIE ERSTELLUNG. `erstelltAm` ist der Tag, an dem
  // die Instanz entstanden ist — beim Archivieren einer ein halbes Jahr alten
  // Instanz stünde dort sonst „läuft seit 4300 Stunden". Einen Startzeitpunkt
  // der Archivierung führt der Datenvertrag nicht; also wird auch keiner
  // behauptet.
  const duration = created ? runtimeInWords(instance.createdAt) : null;
  const hangsFixed =
    created && minutesSince(instance.createdAt) >= HANGS_FIXED_MINUTES;

  if (hangsFixed) {
    return (
      <div
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg border border-einwand-rahmen bg-einwand-bg p-4"
      >
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-einwand-text"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-einwand-text">
            {t('components.instanceCard.text33')}</p>
          <p className="mt-0.5 text-sm text-einwand-text">
            {t('components.instanceCard.text34')}{duration} {t('components.instanceCard.text35')}</p>
          {instance.message && (
            <p className="mt-1 text-sm text-einwand-text">
              {t('components.instanceCard.text36')}{instance.message}"
            </p>
          )}
          {/* Kein „Erneut versuchen": ein Neustart wäre eine dritte
              Schreiboperation gegen Coolify (R1). Angeboten wird nur eine
              Leseanweisung nach außen. */}
          <p className="mt-2 text-sm text-leise">
            {t('components.instanceCard.text37')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className="flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-4"
    >
      <Loader2
        className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-leise"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">
          {created
            ? t('components.instanceCard.text38')
            : t('components.instanceCard.text39')}
        </p>
        <p className="mt-0.5 text-sm text-leise">
          {instance.message ?? t('components.instanceCard.text40')}
          {duration !== null && t('components.instanceCard.text41', { duration: duration })}
        </p>
        {/* Nur noch für einen WIRKLICH laufenden Vorgang — die Endzustände
            sind oben abgefangen. */}
        <p className="mt-2 text-sm text-leise">
          {t('components.instanceCard.text42')}</p>
      </div>
    </div>
  );
}

/** Status `aktiv`: Einladungslink, Stammdaten, Kennzahlen, Sicherung. */
function Active({
  instance,
  companyName,
  invitationLink,
  onInvitationLinkRequest,
  contactEmail,
  onInvitationLinkSend,
  metricsLoading,
  onMetricsFetch,
  onCopy,
}: {
  instance: InstanceDetail;
  companyName: string;
  /** Erst gesetzt, wenn er ausdrücklich angefordert und nachgewiesen wurde. */
  invitationLink: string | null;
  onInvitationLinkRequest: () => void;
  contactEmail: string | null;
  onInvitationLinkSend: () => void;
  metricsLoading: boolean;
  onMetricsFetch: () => void;
  onCopy: (link: string) => void;
}) {
  const t = useT();
  const k = instance.metrics;
  return (
    <>
      {instance.invitationOpen && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-beschluss-rahmen bg-beschluss-bg p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-beschluss-text"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-beschluss-text">
              {t('components.instanceCard.text43')}</p>
            <p className="mt-0.5 text-sm text-beschluss-text">
              {t('components.instanceCard.text44')}{' '}
              {companyName} {t('components.instanceCard.text45')}</p>
            {/* [A.7] Der Link steht NICHT von vornherein auf dem Schirm: Wer
                ihn hat, wird auf der Kundeninstanz Administrator. Er kommt
                erst auf Verlangen und gegen einen zweiten Faktor. */}
            {invitationLink === null ? (
              <Button
                variant="secondary"
                className="mt-2"
                onClick={onInvitationLinkRequest}
              >
                {t('components.instanceCard.button6')}</Button>
            ) : (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-rahmen bg-flaeche px-3 py-2">
                <code className="min-w-0 truncate font-mono text-sm text-text">
                  {invitationLink}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(invitationLink)}
                  aria-label={t('components.instanceCard.ariaLabel')}
                  className="shrink-0 rounded-md p-1.5 text-leise transition-colors hover:bg-flaeche-3 hover:text-text"
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
            {/* DIE ADRESSE STEHT AUF DEM KNOPF, bevor etwas hinausgeht: Wer
                klickt, soll sehen, wohin der Zugang zur Instanz wandert. Fehlt
                sie, gibt es keinen Knopf, der dann erst im Dialog scheitert,
                sondern den Hinweis, wo sie einzutragen ist. */}
            {contactEmail ? (
              <Button
                variant="secondary"
                className="mt-2 max-w-full"
                onClick={onInvitationLinkSend}
              >
                <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {t('components.instanceCard.label')}{contactEmail}
                </span>
              </Button>
            ) : (
              <p className="mt-2 text-sm text-beschluss-text">
                {t('components.instanceCard.text46')}</p>
            )}
          </div>
        </div>
      )}

      {/* Ein Fehlschlag bleibt sichtbar, auch wenn der Status längst steht. */}
      <RemainingMessage message={instance.message} />

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('components.instanceCard.label2')}>{instance.appVersion}</Field>
        <Field label={t('components.instanceCard.label3')}>
          <span className="ziffern-tabellarisch">
            {formatDate(instance.createdAt)}
          </span>
        </Field>

        {instance.configuredAt !== null && (
          <Field label={t('components.instanceCard.label4')}>
            <span className="ziffern-tabellarisch">
              {formatDate(instance.configuredAt)}
            </span>
          </Field>
        )}

        {/* KEINE DIAGRAMME, KEINE KACHELN. Die Zahlen stehen als gewöhnliche
            Feld-Zeilen im selben Raster wie jedes andere Datum dieser Seite;
            der Vergleich ist ein fester 21-Tage-Wert vom Server. */}
        {k && (
          <>
            <Field label={t('components.instanceCard.label5')}>
              <ComparisonValue point={k.activePersons} />
            </Field>
            <Field label={t('components.instanceCard.label6')}>
              <ComparisonValue point={k.circles} />
            </Field>
            <Field label={t('components.instanceCard.label7')}>
              <DayWithGap tag={k.lastEntryAt} />
            </Field>
            <Field label={t('components.instanceCard.label8')}>
              <DayWithGap tag={k.lastLoginAt} />
            </Field>
            <Field label={t('components.instanceCard.label9')}>
              <DayWithGap tag={k.lastSuccessfulQueryAt} />
            </Field>
          </>
        )}

        {/* Unauffällig im gesunden Fall: dasselbe Aussehen wie „App-Version".
            Ein dauerhaftes grünes Häkchen würde zu Hintergrundrauschen, das
            niemand mehr liest — genau das, was der Auftrag verhindern will. */}
        <Field label={t('components.instanceCard.label10')}>
          {instance.backup.last && (
            <>
              <span className="ziffern-tabellarisch">
                {formatDate(instance.backup.last.date)}
              </span>
              {' · '}
              {formatSize(instance.backup.last.sizeBytes)}
            </>
          )}
        </Field>
      </dl>

      {k && <MetricsDisruption metrics={k} />}
      <BackupDisruption backup={instance.backup} />

      {/* Rein lesend gegen die Instanz — derselbe Abruf wie um 04:00, nur
          jetzt. Ohne ihn stand die App-Version einer neuen Instanz bis zum
          nächsten Morgen auf „—". */}
      <div className="mt-3">
        <Button
          variant="secondary"
          loading={metricsLoading}
          onClick={onMetricsFetch}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('components.instanceCard.button7')}</Button>
      </div>

      {/* Zuständigkeitsklärung, keine Statusmeldung — deshalb steht sie immer
          und fällt nicht unter „kein Dauerhäkchen". Es gibt hier bewusst
          keinen Knopf zum Zurückspielen in die bestehende Instanz (E3-15);
          eine NEUE Instanz lässt sich im Bereich „Sicherungen" herstellen. */}
      <p className="mt-2 text-sm text-leise">
        {t('components.instanceCard.text47')}</p>
    </>
  );
}

/** Status `archiviert`: reduzierte Ansicht, keine Live-Kennzahlen. */
function Archived({ instance }: { instance: InstanceDetail }) {
  const t = useT();
  return (
    <>
      <RemainingMessage message={instance.message} />
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('components.instanceCard.label11')}>
          {instance.appVersion}
        </Field>
        <Field label={t('components.instanceCard.label12')}>
          {instance.archivedAt && (
            <span className="ziffern-tabellarisch">
              {formatDate(instance.archivedAt)}
            </span>
          )}
        </Field>
        <Field label={t('components.instanceCard.deletionDay')}>
          {instance.archivedAt && (
            <span className="ziffern-tabellarisch">
              {formatDate(deletionDay(instance.archivedAt))}
            </span>
          )}
        </Field>
        <Field label={t('components.instanceCard.label10')} wide>
          {instance.backup.last && (
            <>
              <span className="ziffern-tabellarisch">
                {formatDate(instance.backup.last.date)}
              </span>
              {' · '}
              {formatSize(instance.backup.last.sizeBytes)}
            </>
          )}
        </Field>
      </dl>
      {/* Genau diese Karte ist der Ort, an dem jemand Wochen später nachsieht,
          „was ist mit der alten Instanz von X". Die Antwort muss ohne
          Rückfrage aus ihr selbst hervorgehen. */}
      <p className="mt-3 text-sm text-leise">
        {t('components.instanceCard.text48')}</p>
    </>
  );
}

/**
 * Die Klartext-Meldung eines abgeschlossenen Vorgangs.
 *
 * Sie trägt das, was es an Fehlschlägen gibt: Es existiert kein Enumwert
 * `fehlgeschlagen`, und was hier nicht steht, steht nirgends sichtbar.
 */
function RemainingMessage({ message }: { message: string | null }) {
  if (message === null || message === '') return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-bedenken-rahmen bg-bedenken-bg px-3 py-2">
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-bedenken-text"
        aria-hidden="true"
      />
      <p className="text-sm text-bedenken-text">{message}</p>
    </div>
  );
}

/** „34 (vor drei Wochen: 28)" — der Vergleich entfällt, wenn es keinen gibt. */
function ComparisonValue({ point }: { point: InstanceMetricsPoint }) {
  const t = useT();
  return (
    <>
      <span className="ziffern-tabellarisch">{point.current}</span>
      {point.beforeThreeWeeks !== null && (
        <span className="ml-1.5 text-leise">
          {t('components.instanceCard.label13')}{' '}
          <span className="ziffern-tabellarisch">{point.beforeThreeWeeks}</span>)
        </span>
      )}
    </>
  );
}

/** Exaktes Datum, daneben die Spanne in Worten — nie an dessen Stelle. */
function DayWithGap({ tag }: { tag: string | null }) {
  if (tag === null) return null;
  return (
    <>
      <span className="ziffern-tabellarisch">{formatDate(tag)}</span>
      <span className="ml-1.5 text-leise">({beforeTimespan(tag)})</span>
    </>
  );
}

/**
 * Fehlgeschlagene Kennzahlen-Abfragen — gemeldet, nicht verschluckt (E3-7).
 *
 * Bedenken (Amber), nicht Einwand (Rot): Eine ausbleibende Kennzahlen-Antwort
 * blockiert im CRM nichts — Notizen, Statuswechsel und Rechnungen laufen
 * weiter, nur das Zahlenbild ist veraltet.
 */
function MetricsDisruption({ metrics }: { metrics: InstanceMetrics }) {
  const t = useT();
  const gestoert =
    metrics.sinceDaysFailed > 0 || metrics.database === 'gestoert';
  if (!gestoert) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-bedenken-rahmen bg-bedenken-bg px-3 py-2">
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-bedenken-text"
        aria-hidden="true"
      />
      <p className="text-sm text-bedenken-text">
        {metrics.sinceDaysFailed === 1
          ? t('components.instanceCard.text49')
          : metrics.sinceDaysFailed > 1
            ? t('components.instanceCard.text50', { sinceDaysFailed: metrics.sinceDaysFailed })
            : t('components.instanceCard.text51')}
        {metrics.sinceDaysFailed > 0 &&
          metrics.lastSuccessfulQueryAt && (
            <>
              {' '}{t('components.instanceCard.text52')}{' '}
              <span className="ziffern-tabellarisch">
                {formatDate(metrics.lastSuccessfulQueryAt)}
              </span>
              .
            </>
          )}
      </p>
    </div>
  );
}

/**
 * Sicherung überfällig — die einzige Stelle, an der die Backup-Anzeige Farbe
 * bekommt.
 *
 * Der Auftrag nennt den Normalfall des Scheiterns: nicht ein Fehlerstatus,
 * sondern wochenlange Stille. Die Gegenmaßnahme ist die Asymmetrie — im
 * gesunden Fall existiert diese Zeile schlicht nicht.
 */
function BackupDisruption({
  backup,
}: {
  backup: InstanceDetail['backup'];
}) {
  const t = useT();
  if (!backup.missing) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-bedenken-rahmen bg-bedenken-bg px-3 py-2">
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-bedenken-text"
        aria-hidden="true"
      />
      <p className="text-sm text-bedenken-text">
        {backup.last ? (
          <>
            {t('components.instanceCard.text53')}{' '}
            <span className="ziffern-tabellarisch">
              {formatDate(backup.last.date)}
            </span>
            .
          </>
        ) : (
          t('components.instanceCard.text54')
        )}
      </p>
    </div>
  );
}
