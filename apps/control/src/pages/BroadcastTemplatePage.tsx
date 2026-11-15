import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, Send } from 'lucide-react';
import {
  Card,
  Button,
  Switch,
  Skeleton,
  Spinner,
  useToast,
} from '@saas-instant/ui';
import { RecipientSelectCard } from '../components/RecipientSelectCard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MailChannelBadge } from '../components/MailChannelBadge';
import { BroadcastTestSendCard } from '../components/BroadcastTestSendCard';
import { BroadcastSendDialog } from '../components/BroadcastSendDialog';
import { BroadcastSendRunCard } from '../components/BroadcastSendRunCard';
import { BroadcastPreview } from '../components/BroadcastPreview';
import {
  draftCarries,
  TemplateFields,
  type TemplateDraft,
} from '../components/TemplateFields';
import { useAuth } from '../context/AuthContext';
import { useT } from '../i18n';
import { errorText } from '../lib/api-client';
import { TEXT_BUTTON, TEXT_BUTTON_ACTION } from '../lib/styles';
import {
  updateTemplate,
  fetchTemplate,
  fetchPreview,
  type EnqueueResult,
  type Template,
  type Preview,
} from '../lib/api';
import { formatDate } from '../utils/date';
import { placeholdersFromInput } from '../utils/placeholders';
import { structureFields } from '../utils/template-structure';

/**
 * Macht aus einer geladenen Vorlage den bearbeitbaren Entwurf.
 *
 * Die beiden Standardplatzhalter fallen dabei WEG: Der Server stellt sie jeder
 * Antwort voran, nimmt sie aber nicht entgegen — stünden sie im Eingabefeld,
 * schriebe man sie beim nächsten Speichern als selbstdeklarierte Namen zurück.
 */
function asDraft(template: Template): TemplateDraft {
  return {
    subject: template.subject,
    // Vorlagen aus der Zeit vor dem Redaktionsfeld haben kein HTML. Aus ihrem
    // Text werden hier Absaetze gemacht, damit das Feld nicht leer bleibt und
    // der Wortlaut nicht als ein einziger Block erscheint. Genau dasselbe tut
    // der Server beim Versand (`htmlFromText`).
    contentHtml: template.contentHtml ?? htmlFromText(template.contentText),
    contentText: template.contentText,
    placeholdersInput: template.placeholders
      .filter((name) => name !== 'company' && name !== 'unsubscribeLink')
      .join(', '),
    // `null` heisst im Formular leerer Text — ein Eingabefeld hat immer einen
    // Wert. Den Weg zurück geht der Server beim Speichern.
    eyebrow: template.eyebrow ?? '',
    heading: template.heading ?? '',
    buttonText: template.buttonText ?? '',
    buttonTarget: template.buttonTarget ?? '',
  };
}

/**
 * ===========================================================================
 * EINE VORLAGE — schreiben, ansehen, testen, verschicken
 * ===========================================================================
 *
 * Die Reihenfolge der Karten ist die Reihenfolge der Arbeit, und sie ist
 * bewusst so und nicht umgekehrt: erst der Text, dann die Vorschau, dann der
 * Testversand an die eigene Adresse, dann wer es bekäme — und ganz zuletzt der
 * unumkehrbare Schritt. Wer den Versandknopf zuerst sähe, hätte ihn irgendwann
 * gedrückt, bevor er die Mail gelesen hat.
 *
 * ZWEI DINGE LASSEN SICH NIE MEHR ÄNDERN und stehen deshalb als Anzeige und
 * nicht als Feld da: der KANAL und der NAME. Beide fehlen im
 * `TemplateUpdateDto`, und beim Kanal ist das die Regel selbst — wäre er
 * änderbar, liesse sich eine Werbebotschaft nachträglich zur Transaktionsmail
 * erklären.
 *
 * DER TRANSAKTIONSKANAL HAT HIER KEINEN VERSANDWEG, und die Seite sagt das
 * offen. `QueueService.enqueue` lädt die Vorlage mit
 * `loadSendable(id, 'marketing')` — eine Transaktionsvorlage würde mit
 * `template_wrong_channel` abgelehnt. Einen Knopf anzubieten, der sicher
 * scheitert, wäre schlechter als keiner.
 *
 * JEDE KARTE STEHT IN EINER `ErrorBoundary`. Fällt die Empfängerauswahl, bleibt
 * der Text bedienbar; fällt die Vorschau, bleibt der Versandlauf erreichbar.
 * Ohne sie reisst ein einzelner Lesefehler die ganze Seite mit — genau der
 * Befund, der die Fehlergrenze überhaupt hervorgebracht hat.
 */
export function BroadcastTemplatePage() {
  const t = useT();
  const { id = '' } = useParams<{ id: string }>();
  const { state } = useAuth();
  const toast = useToast();
  const totpPossible = state?.totpSetUp ?? false;
  const ownAddress = state?.user.email ?? '';

  const [template, setTemplate] = useState<Template | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [sendOpen, setSendOpen] = useState(false);
  const [enqueued, setEnqueued] = useState<EnqueueResult | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  // Zählt jedes Einstellen. Die Fortschrittsanzeige holt daraufhin sofort den
  // neuen Stand, statt bis zum nächsten Takt zu warten.
  const [sendTrigger, setSendTrigger] = useState(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await fetchTemplate(id);
      setTemplate(loaded);
      setDraft(asDraft(loaded));
    } catch (e) {
      setLoadError(errorText(e, t('rundmail.templateLoadFailed')));
      setTemplate(null);
    }
  }, [id, t]);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await fetchPreview(id));
    } catch (e) {
      setPreviewError(errorText(e, t('rundmail.previewLoadFailed')));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function save() {
    // BEIDE müssen dastehen: der Entwurf für die Werte, die Vorlage für den
    // KANAL. Er entscheidet, ob die Strukturfelder überhaupt mitgehen.
    if (draft === null || template === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateTemplate(id, {
        subject: draft.subject.trim(),
        contentHtml: draft.contentHtml,
        placeholders: placeholdersFromInput(draft.placeholdersInput),
        ...structureFields(template.channel, draft),
      });
      setTemplate(saved);
      setDraft(asDraft(saved));
      toast.show(t('rundmail.savedToast'));
      // Die Vorschau zeigt sonst den Text von vorhin — und genau sie ist der
      // Grund, warum man gerade gespeichert hat.
      await loadPreview();
    } catch (e) {
      setSaveError(errorText(e, t('rundmail.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(active: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateTemplate(id, { active });
      setTemplate(saved);
      toast.show(
        active ? t('rundmail.activeAgainToast') : t('rundmail.deactivatedToast'),
      );
    } catch (e) {
      setSaveError(errorText(e, t('rundmail.toggleFailed')));
    } finally {
      setSaving(false);
    }
  }

  if (loadError !== null) {
    return (
      <section>
        <Link to="/broadcast" className={`text-sm ${TEXT_BUTTON}`}>
          {t('rundmail.backToList')}
        </Link>
        <Card className="mt-4 p-6">
          <p role="alert" className="mb-3 text-sm text-gefahr">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('rundmail.retry')}
          </Button>
        </Card>
      </section>
    );
  }

  if (template === null || draft === null) {
    return (
      <section>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="mt-4 h-64 w-full" />
      </section>
    );
  }

  const marketing = template.channel === 'marketing';

  return (
    <section aria-labelledby="template-title">
      <Link to="/broadcast" className={`text-sm ${TEXT_BUTTON_ACTION}`}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('rundmail.backToList')}
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1
          id="template-title"
          className="min-w-0 break-words text-2xl font-semibold tracking-tight text-text"
        >
          {template.name}
        </h1>
        <MailChannelBadge channel={template.channel} />
      </div>
      <p className="mt-1 text-sm text-leise">
        {marketing
          ? t('rundmail.channelDescriptionMarketing')
          : t('rundmail.channelDescriptionTransactional')}
      </p>
      <p className="mt-1 text-sm text-leise">
        {t('rundmail.createdOn')}
        <span className="ziffern-tabellarisch">
          {formatDate(template.createdAt)}
        </span>
        {t('rundmail.lastEditedOn')}
        <span className="ziffern-tabellarisch">
          {formatDate(template.updatedAt)}
        </span>
        {t('rundmail.fixedNote')}
      </p>

      <ErrorBoundary area={t('rundmail.areaForm')}>
        <Card className="mt-6 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text">{t('rundmail.wording')}</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-leise">
                {template.active ? t('rundmail.active') : t('rundmail.inactive')}
              </span>
              <Switch
                on={template.active}
                disabled={saving}
                label={t('rundmail.switchLabel')}
                onToggle={(next) => void toggle(next)}
              />
            </div>
          </div>
          {!template.active && (
            <p className="mb-4 text-sm text-leise">{t('rundmail.inactiveNote')}</p>
          )}

          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void save();
            }}
            noValidate
          >
            <TemplateFields
              draft={draft}
              onChange={setDraft}
              channel={template.channel}
              blocked={saving}
              idPrefix="template"
            />

            {saveError && (
              <p role="alert" className="mb-3 text-sm text-gefahr">
                {saveError}
              </p>
            )}

            <Button
              type="submit"
              loading={saving}
              disabled={!draftCarries(draft)}
            >
              {t('rundmail.saveChanges')}
            </Button>
          </form>
        </Card>
      </ErrorBoundary>

      <ErrorBoundary area={t('rundmail.areaPreview')}>
        <Card className="mt-6 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text">{t('rundmail.preview')}</h2>
            <Button variant="secondary" onClick={() => void loadPreview()}>
              <Eye className="h-4 w-4" aria-hidden="true" />
              {t('rundmail.rebuild')}
            </Button>
          </div>
          <p className="mb-4 text-sm text-leise">{t('rundmail.previewNote')}</p>

          {previewLoading ? (
            <Spinner text={t('rundmail.previewBuilding')} />
          ) : previewError !== null ? (
            <p role="alert" className="text-sm text-gefahr">
              {previewError}
            </p>
          ) : preview !== null ? (
            <BroadcastPreview preview={preview} channel={template.channel} />
          ) : null}
        </Card>
      </ErrorBoundary>

      {marketing ? (
        <>
          <ErrorBoundary area={t('rundmail.areaTestSend')}>
            <BroadcastTestSendCard
              className="mt-6"
              templateId={template.id}
              ownAddress={ownAddress}
              totpPossible={totpPossible}
            />
          </ErrorBoundary>

          <ErrorBoundary area={t('rundmail.areaRecipients')}>
            <RecipientSelectCard
              className="mt-6"
              onLoaded={(selection) => setRecipientCount(selection.count)}
            />
          </ErrorBoundary>

          <ErrorBoundary area={t('rundmail.areaSend')}>
            <Card className="mt-6 p-6">
              <h2 className="text-lg font-semibold text-text">{t('rundmail.sendHeading')}</h2>
              <p className="mt-1 text-sm text-leise">{t('rundmail.sendNote')}</p>

              <Button
                variant="danger"
                className="mt-4"
                disabled={!template.active}
                onClick={() => setSendOpen(true)}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {t('rundmail.sendButton')}
              </Button>
              {!template.active && (
                <p className="mt-2 text-sm text-leise">{t('rundmail.inactiveHint')}</p>
              )}

              <div aria-live="polite">
                {enqueued !== null && (
                  <div className="mt-4 rounded-lg border border-beschluss-rahmen bg-beschluss-bg p-3">
                    <p className="text-sm font-semibold text-beschluss-text">
                      {enqueued.enqueued === 1
                        ? t('rundmail.enqueuedOne', { name: enqueued.template })
                        : t('rundmail.enqueuedMany', {
                            count: enqueued.enqueued,
                            name: enqueued.template,
                          })}
                    </p>
                    <p className="mt-1 text-sm text-beschluss-text">
                      {t('rundmail.enqueuedNote')}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          </ErrorBoundary>

          <ErrorBoundary area={t('rundmail.areaRun')}>
            <BroadcastSendRunCard
              className="mt-6"
              templateId={template.id}
              trigger={sendTrigger}
              totpPossible={totpPossible}
            />
          </ErrorBoundary>

          <BroadcastSendDialog
            open={sendOpen}
            template={template}
            recipientCount={recipientCount}
            totpPossible={totpPossible}
            onClose={() => setSendOpen(false)}
            onEnqueued={(result) => {
              setSendOpen(false);
              setEnqueued(result);
              setSendTrigger((before) => before + 1);
              toast.show(t('rundmail.enqueuedToast'));
            }}
          />
        </>
      ) : (
        <Card className="mt-6 p-6">
          <h2 className="text-lg font-semibold text-text">{t('rundmail.noSendTitle')}</h2>
          <p className="mt-1 text-sm text-leise">{t('rundmail.noSendText')}</p>
          <p className="mt-2 text-sm text-leise">
            {t('rundmail.noSendButtonBefore')}{' '}
            <span className="font-mono text-xs">template_wrong_channel</span>{' '}
            {t('rundmail.noSendButtonAfter')}
          </p>
        </Card>
      )}
    </section>
  );
}


/**
 * Text zu Absaetzen — fuer Vorlagen ohne HTML-Fassung.
 *
 * Bewusst dieselbe Regel wie serverseitig: Leerzeile trennt Absaetze, ein
 * einzelner Umbruch wird zu `<br>`. Der Text wird dabei escaped; er kann eine
 * Adresse oder einen Namen enthalten, und im Redaktionsfeld darf daraus kein
 * Markup entstehen.
 */
function htmlFromText(text: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
