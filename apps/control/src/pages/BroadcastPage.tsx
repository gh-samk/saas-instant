import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, Mails, Plus, ShieldCheck } from 'lucide-react';
import {
  IconButton,
  Card,
  Button,
  EmptyState,
  Skeleton,
  StatusPill,
  Table,
  useToast,
} from '@saas-instant/ui';
import { BroadcastTabs } from '../components/BroadcastTabs';
import { TemplatePreviewDialog } from '../components/TemplatePreviewDialog';
import { useBroadcastNumbers } from '../lib/broadcast-numbers';
import { TemplateCreateDialog } from '../components/TemplateCreateDialog';
import { useT } from '../i18n';
import { errorText } from '../lib/api-client';
import { TEXT_BUTTON } from '../lib/styles';
import { fetchTemplates, type Template } from '../lib/api';
import { formatDate } from '../utils/date';

/**
 * ===========================================================================
 * DER REDAKTIONSBEREICH — die Vorlagen, nach Kanälen getrennt
 * ===========================================================================
 *
 * EINE TABELLE, NICHT MEHR ZWEI ABSCHNITTE — und der Kanal steht als Pille in
 * einer eigenen Spalte. Vorher stand hier die Gegenentscheidung, mit zwei
 * Begründungen:
 *
 * 1. „Eine gemischte Liste mit kleinem Abzeichen wäre die Einladung, sich zu
 *    vergreifen." Der Einwand war ernst gemeint und ist trotzdem entkräftet:
 *    Vergreifen könnte man sich nur beim VERSENDEN, und der Weg dorthin ist
 *    je Kanal ein anderer. Eine Transaktionsvorlage hat in dieser Liste
 *    keinen aktiven Sendeknopf — sie geht je Vorgang hinaus, nicht auf
 *    Zuruf. Die Spalte „Empfänger" sagt das im Klartext.
 * 2. „Fünf Angaben je Zeile ergäben bei 375 px die nächste waagerecht
 *    scrollende Struktur." Das stimmt — und ist seit Etappe 2 gelöst:
 *    `Tabelle` scrollt waagerecht IN IHREM Behälter, nicht im Dokument.
 *    Dieselbe Bauart tragen inzwischen Organisationen und Rechnungen; eine
 *    dritte Bauform für dieselbe Aufgabe wäre die eigentliche Zumutung.
 *
 * DER KANAL BLEIBT UNVERÄNDERLICH. Daran ändert die Darstellung nichts: Er
 * fällt beim Anlegen und lässt sich hinterher nicht korrigieren.
 *
 * REDIGIEREN OHNE ZWEITEN FAKTOR, VERSENDEN NUR MIT. Der Server hält es
 * genauso: `BroadcastController` (schreiben, lesen, Vorschau) hängt allein am
 * `SessionGuard`, `BroadcastSendController` zusätzlich am
 * `SecondFactorGuard`. Wer Texte schreibt, erreicht damit niemanden.
 */
export function BroadcastPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [preview, setPreview] = useState<Template | null>(null);
  const { numbers } = useBroadcastNumbers();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await fetchTemplates();
      // Die Form der Antwort wird geprüft, nicht geglaubt: Ein `.filter` auf
      // etwas, das keine Liste ist, risse sonst die ganze Seite mit.
      if (!Array.isArray(list)) {
        setLoadError(t('rundmail.unexpectedShape'));
        setTemplates(null);
        return;
      }
      setTemplates(list);
    } catch (e) {
      setLoadError(errorText(e, t('rundmail.loadFailed')));
      setTemplates(null);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="broadcast-title">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-4">
        <h1
          id="broadcast-title"
          className="min-w-0 font-serif text-2xl font-bold text-text"
        >
          {t('rundmail.title')}
        </h1>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full shrink-0 sm:w-auto"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {/* DER ENTWURF SCHREIBT „+ Rundmail". Hier steht „Vorlage anlegen",
              und das ist kein Übersehen: Der Knopf legt eine VORLAGE an, und
              eine Vorlage ist keine Rundmail. Sie kann sogar transaktional
              sein — dann geht sie nie als Rundmail hinaus. Der Entwurf
              kennt die Unterscheidung nicht; dieses System trifft sie an
              jeder Stelle, und der Kanal lässt sich nach dem Anlegen nicht
              mehr korrigieren. */}
          {t('rundmail.createTemplate')}
        </Button>
      </div>

      <BroadcastTabs numbers={numbers} />

      {/* DER SATZ BLEIBT, nur kürzer. Er ist die wichtigste Aussage der
          Seite: Wer eine Rundmail bekommt, entscheidet nicht diese Liste,
          sondern die Prüfung unmittelbar vor jeder einzelnen Mail. */}
      <Card className="mb-5 flex flex-wrap items-center justify-between gap-3 border-beschluss-rahmen-hell bg-beschluss-bg p-3.5">
        <p className="flex min-w-0 items-start gap-2.5 text-sm text-beschluss-text">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('rundmail.consentNotice')}
        </p>
        <Link to="/broadcast/consents" className={`shrink-0 ${TEXT_BUTTON}`}>
          {t('rundmail.consentsLink')}
        </Link>
      </Card>

      {loadError ? (
        <Card className="p-6">
          <p role="alert" className="mb-3 text-sm text-gefahr">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('rundmail.retry')}
          </Button>
        </Card>
      ) : templates === null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            Icon={Mails}
            title={t('rundmail.emptyTitle')}
            notice={t('rundmail.emptyHint')}
            action={
              <Button onClick={() => setCreateOpen(true)}>
                {t('rundmail.createTemplate')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table
            variant="list"
            label={t('rundmail.tableCaption')}
            columns={[
              t('rundmail.columnTemplate'),
              t('rundmail.columnChannel'),
              t('rundmail.columnRecipients'),
              t('rundmail.columnChanged'),
              t('rundmail.columnActions'),
            ]}
            columnsWidths={['w-4/12', 'w-2/12', 'w-2/12', 'w-2/12', 'w-2/12']}
            actionColumn
            minWidth="min-w-[760px]"
          >
            {templates.map((template) => (
              <tr key={template.id}>
                <td className="px-3 py-2.5">
                  {/* KEIN `ZEILEN_LINK_KLASSEN` HIER: Die Klasse setzt
                      `inline-flex`, und dann stünde der Betreff NEBEN dem
                      Namen statt darunter. Sie ist für einzeilige Handlungen
                      am Zeilenende gedacht, nicht für einen zweizeiligen
                      Titelblock. */}
                  <Link
                    to={`/broadcast/${template.id}`}
                    className="block rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaer"
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-text">
                      {template.name}
                      {!template.active && (
                        <StatusPill kind="neutral">{t('rundmail.inactive')}</StatusPill>
                      )}
                    </span>
                    <span className="block break-words text-xs text-leise">
                      {template.subject}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill
                    kind={template.channel === 'marketing' ? 'notice' : 'neutral'}
                  >
                    {template.channel === 'marketing'
                      ? t('rundmail.channelMarketing')
                      : t('rundmail.channelTransactional')}
                  </StatusPill>
                </td>
                {/* DIE SPALTE, DIE DEN ALTEN EINWAND ENTKRÄFTET: Sie sagt je
                    Zeile, WER die Mail bekommt — eine Zahl beim werblichen
                    Kanal, „je Vorgang" beim transaktionalen. Wer beides
                    nebeneinander sieht, verwechselt es nicht. */}
                <td className="px-3 py-2.5 text-sm text-leise">
                  {template.channel === 'marketing' ? (
                    <span className="ziffern-tabellarisch">
                      {numbers.confirmed ?? '—'}
                    </span>
                  ) : (
                    t('rundmail.perProcess')
                  )}
                </td>
                <td className="ziffern-tabellarisch px-3 py-2.5 text-sm text-leise">
                  {formatDate(template.updatedAt)}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <IconButton
                      Icon={Eye}
                      label={t('rundmail.previewLabel', { name: template.name })}
                      onClick={() => setPreview(template)}
                    />
                    {/* KEIN AKTIVER SENDEKNOPF BEIM TRANSAKTIONSKANAL. Eine
                        Transaktionsmail geht je Vorgang hinaus, nicht auf
                        Zuruf; ein Knopf dafür verspräche etwas, das der
                        Server abweist (`TemplateWrongChannelError`).

                        BEIM WERBLICHEN KANAL FÜHRT ER AUF DIE VORLAGENSEITE
                        und verschickt nicht selbst — deshalb die drei Punkte.
                        Dort stehen der Zweitfaktor, die Empfängerauswahl und
                        der Fortschritt des Laufs. Sie in eine Tabellenzeile
                        zu holen hiesse, den ganzen Versandweg ein zweites Mal
                        zu bauen. */}
                    {template.channel === 'marketing' ? (
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-sm"
                        onClick={() => navigate(`/broadcast/${template.id}`)}
                      >
                        {t('rundmail.sendMore')}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-sm"
                        disabled
                        title={t('rundmail.sendDisabledTitle')}
                      >
                        {t('rundmail.send')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <TemplatePreviewDialog
        templateId={preview?.id ?? null}
        name={preview?.name ?? ''}
        channel={preview?.channel ?? 'marketing'}
        onClose={() => setPreview(null)}
      />

      <TemplateCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(template) => {
          setCreateOpen(false);
          toast.show(t('rundmail.createdToast'));
          // Direkt in die Vorlage: Dort steht die Vorschau, und die ist der
          // erste Blick, den man nach dem Schreiben braucht.
          navigate(`/broadcast/${template.id}`);
        }}
      />
    </section>
  );
}
