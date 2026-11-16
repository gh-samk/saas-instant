import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Globe, Info, Loader2 } from 'lucide-react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { Field } from './DetailBlock';
import { fieldLabel } from './FormFields';
import { ApiError, errorText } from '../lib/api-client';
import {
  generateInstancePreview,
  fetchSubdomainSuggestion,
  createInstance,
  checkSubdomain,
  type InstanceDetail,
  type InstancePreview,
} from '../lib/api';
import {
  alternativeSubdomains,
  normalizeSubdomain,
  subdomainFormatError,
} from '../utils/subdomain';
import { TEXT_BUTTON } from '../lib/styles';
import { useT } from '../i18n';

type Step = 'subdomain' | 'preview';
/**
 * `idle`: nichts zu prüfen (leer oder Format falsch). `unknown`: die Prüfung
 * ist gerade NICHT möglich (Dienst nicht erreichbar) — ausdrücklich etwas
 * anderes als `taken`, die Subdomain gehört schon jemandem.
 */
type CheckStatus = 'idle' | 'checking' | 'available' | 'taken' | 'unknown';

/** Wartezeit, bevor eine Eingabe zur Verfügbarkeitsanfrage wird. */
const CHECK_DELAY_MS = 500;

/**
 * Instanz anlegen — zweistufig, mit PFLICHT-VORSCHAU.
 *
 * DIE VORSCHAU IST KEINE HÖFLICHKEIT DER OBERFLÄCHE. Der Wechsel auf Schritt 2
 * ruft `POST …/instanz/vorschau`; ohne diese serverseitig angelegte, atomar
 * verbrauchte Zeile antwortet das Anlegen mit `409 vorschau_fehlt`. Ein
 * Aufrufer, der den Dialog umgeht, kommt also nicht durch (E3-9).
 *
 * IHR ZWECK IST EIN TIPPFEHLER, DER AUFFÄLLT — eine falsch getippte Subdomain,
 * die eine bestehende überschreibt, wäre bei voller Automatik ein stiller
 * Datenverlust. Drei Maßnahmen zusammen, keine davon allein reicht:
 *
 * 1. Vorschlag statt leerem Feld. Er kommt vom Server aus dem bereits
 *    geprüften Organisationsnamen — wer ihn übernimmt, tippt gar nichts.
 * 2. Verfügbarkeitsprüfung VOR dem Weitergehen. Eine vergebene Subdomain wird
 *    nie bis zur Bestätigung durchgereicht.
 * 3. Der Organisationsname steht in der Vorschau direkt über der Subdomain.
 *    „Musterverein Ostend e. V." neben `musterverein-nord` fällt
 *    beim Nebeneinanderlesen auf — das ist der Zweck dieser Anordnung, keine
 *    Dekoration.
 *
 * ABWEICHUNG VON DER SPEZIFIKATION, begründet: Dort wird der Vorschlag beim
 * Öffnen NICHT geprüft, sondern erst nach der ersten Interaktion. Zugleich ist
 * „Weiter" gesperrt, bis die Prüfung „verfügbar" meldet — wer den Vorschlag
 * unverändert übernehmen will, säße also vor einem gesperrten Knopf ohne
 * erkennbaren Grund. Der Vorschlag wird deshalb geprüft, sobald er im Feld
 * steht. Er ist zu diesem Zeitpunkt sichtbar, die Anfrage geht an den eigenen
 * Server, und eine bereits vergebene vorgeschlagene Subdomain fällt so
 * sofort auf statt erst nach einem Umweg.
 *
 * WAS DIE OBERFLÄCHE DAVON ZEIGT, hängt an der Eingabe: Der Vorschlag wird
 * still geprüft. Ist er vergeben, setzt der Dialog den ersten freien
 * Ausweichnamen (`-2`, `-3` …) ein, ohne etwas Rotes zu zeigen — niemand hat
 * etwas Falsches getippt. Erst wenn jemand tippt oder das Feld verlässt,
 * erscheint „vergeben" als Fehler am Feld, samt freiem Vorschlag zum
 * Übernehmen. „Prüfung gerade nicht möglich" ist ein neutraler Hinweis mit
 * Wiederholen-Knopf, kein Fehler am Feld.
 */
export function InstanceCreateDialog({
  open,
  companyId,
  companyName,
  onClose,
  onCreated,
  returnFocusTo,
}: {
  open: boolean;
  companyId: string;
  companyName: string;
  onClose: () => void;
  /** Ziel für den Fokus nach dem Schließen, falls der Auslöser fehlt (siehe `Dialog`). */
  returnFocusTo?: () => HTMLElement | null;
  onCreated: (instance: InstanceDetail) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>('subdomain');
  const [subdomain, setSubdomain] = useState('');
  const [checkStatus, setCheckStatus] = useState<CheckStatus>('idle');
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** Hat jemand getippt oder das Feld verlassen? Erst dann zählt „vergeben" als Fehler. */
  const [touched, setTouched] = useState(false);
  /** Erster freier Ausweichname zu einer vergebenen Subdomain. */
  const [alternative, setAlternative] = useState<string | null>(null);
  /** Hochgezählt, um die Prüfung von Hand zu wiederholen. */
  const [recheck, setRecheck] = useState(0);
  const touchedRef = useRef(false);
  const [preview, setPreview] = useState<InstancePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /** Zählt die Prüfläufe: nur die Antwort auf die JÜNGSTE Eingabe zählt. */
  const checkRun = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const formatError = subdomainFormatError(subdomain);
  const takenError =
    checkStatus === 'taken' && touched ? t('components.instanceCreateDialog.text') : null;
  const errorTextField = formatError ?? fieldError ?? takenError;

  function touch() {
    touchedRef.current = true;
    setTouched(true);
  }

  // Beim Öffnen zurück auf Anfang und den Vorschlag holen. Ein abgebrochener
  // Versuch soll beim nächsten Öffnen nicht mit alten Werten dastehen.
  useEffect(() => {
    if (!open) return;
    let discarded = false;
    setStep('subdomain');
    setSubdomain('');
    setCheckStatus('idle');
    setFieldError(null);
    setAlternative(null);
    setTouched(false);
    touchedRef.current = false;
    setPreview(null);
    setCreateError(null);
    void fetchSubdomainSuggestion(companyId)
      .then((response) => {
        if (!discarded) setSubdomain(response.subdomain);
      })
      .catch(() => {
        // Ohne Vorschlag bleibt das Feld leer — tippbar ist es trotzdem. Ein
        // eigener Fehlertext dafür wäre lauter als der Verlust wiegt.
      });
    return () => {
      discarded = true;
    };
  }, [open, companyId]);

  // Verfügbarkeitsprüfung, gesammelt über 500 ms. Etwas großzügiger als die
  // 300 ms der Organisationssuche: hier entscheidet ein Netzwerk-Roundtrip
  // über ein Gate, dort filtert er nur eine Liste.
  useEffect(() => {
    if (!open || step !== 'subdomain') return;
    if (subdomain === '' || formatError !== null) {
      setCheckStatus('idle');
      setAlternative(null);
      return;
    }
    const run = ++checkRun.current;
    setCheckStatus('checking');
    setFieldError(null);
    setAlternative(null);
    const clock = setTimeout(() => {
      void (async () => {
        try {
          const response = await checkSubdomain(companyId, subdomain);
          if (run !== checkRun.current) return;
          if (response.available) {
            setCheckStatus('available');
            return;
          }
          if (response.reason === 'unverifiable') {
            setCheckStatus('unknown');
            return;
          }
          // Wer getippt hat, sieht „vergeben" sofort. Beim Vorschlag bleibt es
          // bei „wird geprüft", bis feststeht, ob sich ein Ersatz findet —
          // sonst blitzte kurz eine Meldung auf, die gleich wieder verschwindet.
          if (touchedRef.current) setCheckStatus('taken');
          // Einen freien Ausweichnamen suchen. Wird dabei die Prüfung selbst
          // unmöglich, bleibt es beim Hinweis „vergeben" ohne Vorschlag.
          for (const candidate of alternativeSubdomains(subdomain)) {
            const other = await checkSubdomain(companyId, candidate);
            if (run !== checkRun.current) return;
            if (other.available) {
              // Den NICHT getippten Vorschlag still ersetzen; eine Eingabe
              // bleibt stehen und bekommt den Namen nur angeboten.
              if (touchedRef.current) setAlternative(candidate);
              else setSubdomain(candidate);
              return;
            }
            if (other.reason === 'unverifiable') break;
          }
          setCheckStatus('taken');
        } catch (f: unknown) {
          if (run !== checkRun.current) return;
          // Eine Ablehnung des Servers mit Begründung (reservierter Name) steht
          // im Wortlaut am Feld. Alles andere — Netz, 5xx, Drosselung — heißt
          // nur: gerade nicht prüfbar.
          if (f instanceof ApiError && f.status >= 400 && f.status < 500 && f.status !== 429 && f.status !== 403) {
            setCheckStatus('idle');
            setFieldError(errorText(f, t('components.instanceCreateDialog.text2')));
          } else {
            setCheckStatus('unknown');
          }
        }
      })();
    }, CHECK_DELAY_MS);
    return () => clearTimeout(clock);
  }, [open, step, subdomain, formatError, companyId, recheck]);

  // Nach dem Schrittwechsel wandert der Fokus in den neuen Inhalt — `Dialog`
  // tut das nur beim Öffnen, nicht bei einem internen Wechsel.
  useEffect(() => {
    if (step === 'preview') previewRef.current?.focus();
  }, [step]);

  const close = useCallback(() => {
    if (createLoading) return;
    onClose();
  }, [createLoading, onClose]);

  async function nextToPreview() {
    if (checkStatus !== 'available' || subdomain === '') return;
    setPreviewLoading(true);
    setFieldError(null);
    try {
      setPreview(await generateInstancePreview(companyId, subdomain));
      setCreateError(null);
      setStep('preview');
    } catch (f) {
      // Zwischen Prüfung und Vorschau kann die Subdomain vergeben worden sein.
      if (f instanceof ApiError && f.error.code === 'subdomain_taken') {
        setCheckStatus('taken');
      }
      setFieldError(
        errorText(f, t('components.instanceCreateDialog.text3')),
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function create() {
    setCreateLoading(true);
    setCreateError(null);
    try {
      onCreated(await createInstance(companyId, { subdomain }));
    } catch (f) {
      setCreateError(
        errorText(f, t('components.instanceCreateDialog.text4')),
      );
    } finally {
      setCreateLoading(false);
    }
  }

  // Der Vorschlag war vergeben und es fand sich kein freier Ersatz: neutral
  // sagen, was zu tun ist, solange noch nichts getippt wurde.
  const untouchedTaken = checkStatus === 'taken' && !touched;

  const context = (
    <p className="mb-4 text-sm text-leise">
      {t('components.instanceCreateDialog.text5')}<span className="font-medium text-text">{companyName}</span>
    </p>
  );

  return (
    <Dialog
      open={open}
      title={step === 'preview' ? t('components.instanceCreateDialog.title') : t('components.instanceCreateDialog.title2')}
      eyebrow={step === 'preview' ? t('components.instanceCreateDialog.eyebrow') : undefined}
      size={step === 'preview' ? 'lg' : 'sm'}
      returnFocusTo={returnFocusTo}
      onClose={close}
      footer={
        step === 'subdomain' ? (
          <>
            <Button variant="ghost" type="button" onClick={close}>
              {t('components.instanceCreateDialog.button')}</Button>
            <Button
              form="instanz-subdomain"
              type="submit"
              loading={previewLoading}
              disabled={checkStatus !== 'available' || subdomain === ''}
            >
              {t('components.instanceCreateDialog.button2')}</Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setStep('subdomain')}
              disabled={createLoading}
            >
              {t('components.instanceCreateDialog.button3')}</Button>
            <Button
              variant="primary"
              type="button"
              loading={createLoading}
              onClick={() => void create()}
            >
              {t('components.instanceCreateDialog.button4')}</Button>
          </>
        )
      }
    >
      {step === 'subdomain' ? (
        <form
          id="instanz-subdomain"
          onSubmit={(e) => {
            e.preventDefault();
            void nextToPreview();
          }}
          noValidate
        >
          {context}
          <InputField
            id="instanz-subdomain-feld"
            name="subdomain"
            label={fieldLabel(t('components.instanceCreateDialog.label'), 'required')}
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={subdomain}
            onChange={(e) => {
              touch();
              setSubdomain(normalizeSubdomain(e.target.value));
            }}
            onBlur={() => {
              if (subdomain !== '') touch();
            }}
            error={errorTextField ?? undefined}
            helperText={
              errorTextField
                ? undefined
                : t('components.instanceCreateDialog.helperText')
            }
          />
          {/* Der Zustand der Prüfung steht am Feld, nicht am Knopf: dort
              entsteht er, und ein zweiter Ladezustand wäre Wiederholung. */}
          {!errorTextField && checkStatus === 'checking' && (
            <p className="-mt-3 mb-4 flex items-center gap-1.5 text-sm text-leise">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('components.instanceCreateDialog.text6')}</p>
          )}
          {!errorTextField && checkStatus === 'available' && (
            <p className="-mt-3 mb-4 flex items-center gap-1.5 text-sm text-beschluss-text">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('components.instanceCreateDialog.text7')}</p>
          )}
          {/* Freier Ersatz zum Übernehmen — nur, wenn das Getippte vergeben ist. */}
          {takenError && alternative !== null && (
            <p className="-mt-3 mb-4 text-sm text-leise">
              {t('components.instanceCreateDialog.alternative')}{' '}
              <button
                type="button"
                className={TEXT_BUTTON}
                onClick={() => setSubdomain(alternative)}
              >
                {alternative}
              </button>
            </p>
          )}
          {untouchedTaken && (
            <p role="status" className="-mt-3 mb-4 flex items-start gap-1.5 text-sm text-leise">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t('components.instanceCreateDialog.takenSuggestion')}
            </p>
          )}
          {/* Nicht prüfbar ist KEIN Fehler am Feld und heißt nicht „vergeben". */}
          {!errorTextField && checkStatus === 'unknown' && (
            <p role="status" className="-mt-3 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-leise">
              <span className="flex min-w-0 items-start gap-1.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t('components.instanceCreateDialog.unknown')}</span>
              </span>
              <button type="button" className={TEXT_BUTTON} onClick={() => setRecheck((n) => n + 1)}>
                {t('components.instanceCreateDialog.recheck')}
              </button>
            </p>
          )}
        </form>
      ) : (
        preview && (
          <div ref={previewRef} tabIndex={-1} className="focus:outline-none">
            {context}
            {/* Name und Adresse stehen bewusst UNMITTELBAR untereinander —
                genau hier fällt eine falsch getippte Subdomain auf. */}
            <div className="rounded-lg border-2 border-primaer bg-primaer-soft p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-primaer-softtext">
                {t('components.instanceCreateDialog.text8')}</p>
              <p className="text-lg font-semibold text-text break-words">
                {companyName}
              </p>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche px-3 py-2">
                <Globe
                  className="h-4 w-4 shrink-0 text-leise"
                  aria-hidden="true"
                />
                <code className="min-w-0 break-words font-mono text-sm font-semibold text-text">
                  {preview.url}
                </code>
              </div>
              {/* KEIN Fehler und kein Bedenken-Hinweis: eine abweichende
                  Subdomain ist oft beabsichtigt (kürzerer Name). Die Zeile
                  soll auffallen, ohne eine legitime Entscheidung wie einen
                  Fehler aussehen zu lassen. */}
              {preview.deviatesBySuggestionFrom && (
                <p className="mt-1.5 text-xs text-leise">
                  {t('components.instanceCreateDialog.text9')}{preview.suggestedSubdomain}
                  {t('components.instanceCreateDialog.text10')}</p>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-4">
              <Field label={t('components.instanceCreateDialog.label2')}>
                <code className="font-mono text-sm break-all">
                  {preview.applicationName}
                </code>
              </Field>
              <Field label={t('components.instanceCreateDialog.label3')}>
                <code className="font-mono text-sm break-all">
                  {preview.databaseName}
                </code>
              </Field>
              <Field label={t('components.instanceCreateDialog.label4')}>
                <code className="font-mono text-xs break-all">
                  {preview.environmentVariables.join(' · ')}
                </code>
                <span className="mt-0.5 block text-xs text-leise">
                  {t('components.instanceCreateDialog.label5')}</span>
              </Field>
              <Field label={t('components.instanceCreateDialog.label6')}>
                {t('components.instanceCreateDialog.text11')}</Field>
            </dl>

            <p className="mt-4 text-xs text-leise">
              {t('components.instanceCreateDialog.text12')}</p>

            {createError && (
              <p role="alert" className="mt-3 text-sm text-gefahr">
                {createError}
              </p>
            )}
          </div>
        )
      )}
    </Dialog>
  );
}
