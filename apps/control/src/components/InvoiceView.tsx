import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ban,
  Download,
  FileCode,
  Landmark,
  MailWarning,
  Send,
} from 'lucide-react';
import { Dialog, Card, Button, Table, useToast } from '@saas-instant/ui';
import { Field } from './DetailBlock';
import { InvoiceCancelDialog } from './InvoiceCancelDialog';
import { TransferNoteDialog } from './TransferNoteDialog';
import { PaymentRecordDialog } from './PaymentRecordDialog';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { InvoiceIntegrity } from './InvoiceIntegrity';
import { apiFile, errorText } from '../lib/api-client';
import { tableRow } from '../lib/density';
import { TEXT_BUTTON, TEXT_BUTTON_ACTION } from '../lib/styles';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  fetchInvoice,
  sendPaymentReminder,
  sendInvoice,
  type Invoice,
  type InvoiceWithRetention,
  type SecondFactorEvidence,
} from '../lib/api';
import { formatAmount } from '../utils/amount';
import { formatQuantity, formatPercent } from '../utils/decimal';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

/** Klassen eines `Knopf variante="sekundaer"` für ein echtes `<a>`. */
const BUTTON_SECONDARY_AS_LINK =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-rahmen bg-flaeche px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-flaeche-3';

/**
 * Holt die NUMMER einer verwiesenen Rechnung.
 *
 * `RechnungAntwort` liefert beim Storno-Paar nur die ID der jeweils anderen
 * Rechnung. „Storniert durch 8f3c-…" wäre für Menschen wertlos, deshalb ein
 * zweiter, leichter Aufruf. Bis er zurück ist, steht ein Platzhalter fester
 * Breite da — kein Layoutsprung.
 */
function useInvoiceNumber(id: string | null): string | null {
  const [number, setNumber] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) {
      setNumber(null);
      return;
    }
    let lives = true;
    setNumber(null);
    void fetchInvoice(id)
      .then((r) => {
        if (lives) setNumber(r.invoiceNumber);
      })
      .catch(() => {
        // Kein Fehlerzustand: Der Verweis funktioniert auch ohne Nummer, und
        // ein Fehlerbanner für eine Beschriftung wäre unverhältnismäßig.
      });
    return () => {
      lives = false;
    };
  }, [id]);
  return number;
}

function NumberSlot({ number }: { number: string | null }) {
  // Die Mindestbreite gilt NUR für den Platzhalter. Behielte sie die geladene
  // Nummer bei, stünde die Kastenbreite hinter dem Text weiter — im
  // Screenshot bei 375 px als „storniert 2026-014 ." mit Leerzeichen vor dem
  // Punkt. Der Zweck (kein Sprung beim Nachladen) bleibt erhalten.
  if (number === null) {
    return (
      <span
        className="ziffern-tabellarisch inline-block min-w-16"
        aria-hidden="true"
      >
        …
      </span>
    );
  }
  return <span className="ziffern-tabellarisch">{number}</span>;
}

/** Wofür gerade ein Nachweis verlangt wird — der Dialog ist derselbe. */
type SendPurpose = 'send' | 'reminder';

const SEND_TEXT: Record<
  SendPurpose,
  { title: string; declaration: string; success: string; error: string }
> = {
  send: {
    title: t('components.invoiceView.title'),
    declaration:
      t('components.invoiceView.declaration'),
    success: t('components.invoiceView.success'),
    error: t('components.invoiceView.error'),
  },
  reminder: {
    title: t('components.invoiceView.title2'),
    declaration:
      t('components.invoiceView.declaration2'),
    success: t('components.invoiceView.success2'),
    error: t('components.invoiceView.error2'),
  },
};

/**
 * Die FESTGESCHRIEBENE Rechnung — reine Ansicht.
 *
 * ES GIBT HIER STRUKTURELL KEINEN STIFT UND KEIN LÖSCHEN. Der `Detailblock`
 * aus Etappe 2 wird bewusst NICHT wiederverwendet: Seine ganze
 * Existenzberechtigung ist „bearbeitbar machen". Ihn hier einzusetzen und den
 * Stift wegzulassen ergäbe ein Bauteil, das aussieht, als ginge Ändern — und
 * genau das soll es nicht. Die Oberfläche verspricht nichts, was das Backend
 * nicht hält: Dort existiert für eine festgeschriebene Rechnung weder ein
 * `PATCH` noch ein `DELETE`, nicht als abgewiesener Aufruf, sondern als
 * fehlende Route.
 *
 * DAS STORNO-PAAR STEHT AUF BEIDEN SEITEN GANZ OBEN. Wer eine der beiden
 * Rechnungen öffnet, soll nie übersehen, dass es die andere gibt: Hier wurde
 * nichts gelöscht, hier steht eine Korrektur daneben.
 */
export function InvoiceView({
  invoice,
  companyId,
  totpPossible,
  contactDataDeleted,
  onChanged,
  onCancelled,
}: {
  invoice: InvoiceWithRetention;
  companyId: string;
  totpPossible: boolean;
  /**
   * Wurden die Kontaktdaten der Organisation gelöscht? [H5]
   *
   * Der Schnappschuss der Rechnung BLEIBT dabei stehen — er gehört zum Beleg
   * und ist zehn Jahre aufzubewahren. Ein NEUER Versand an diese Adresse wäre
   * dagegen eine weitere Verarbeitung nach dem Löschverlangen. Deshalb keine
   * Sperre (die Rechnung selbst darf hinausgehen müssen), aber eine Nachfrage.
   */
  contactDataDeleted: boolean;
  onChanged: (invoice: Invoice) => void;
  onCancelled: (result: { original: Invoice; cancellation: Invoice }) => void;
}) {
  const t = useT();
  const toast = useToast();

  /**
   * Holt PDF oder XML und legt es als Download vor.
   *
   * Scheitert es, erscheint die Meldung des Servers dort, wo die Benutzerin
   * gerade hinsieht — statt als rohes JSON in einem neuen Tab. Die Meldungen
   * sind bereits für Menschen geschrieben; `fehlertext` nimmt sie, wie sie
   * sind, und hat nur für den Fall einen Ersatz, dass gar keine ankommt.
   *
   * Der Objekt-Verweis wird sofort wieder freigegeben. Ohne das hielte jeder
   * Klick das PDF im Speicher, bis die Seite neu geladen wird.
   */
  async function fetch(
    event: React.MouseEvent<HTMLAnchorElement>,
    weg: 'document' | 'xml' | 'xrechnung',
    ending: string,
  ): Promise<void> {
    // Mittelklick, Cmd/Strg-Klick und Kontextmenü NICHT abfangen: Wer
    // ausdrücklich einen neuen Tab will, soll ihn bekommen.
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();

    try {
      const { blob, fileName } = await apiFile(
        `/api/invoices/${invoice.id}/${weg}`,
      );
      const reference = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = reference;
      anchor.download =
        fileName ?? `${invoice.invoiceNumber ?? 'rechnung'}.${ending}`;
      anchor.click();
      URL.revokeObjectURL(reference);
    } catch (f) {
      toast.show(
        errorText(f, t('components.invoiceView.text')),
        'error',
      );
    }
  }
  const [sendLoading, setSendLoading] = useState(false);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [cancellationOpen, setCancellationOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [sendPurpose, setSendPurpose] = useState<SendPurpose | null>(null);
  const [warningPurpose, setWarningPurpose] = useState<SendPurpose | null>(null);
  const evidenceState = useSecondFactorEvidence();

  const cancellationNumber = useInvoiceNumber(invoice.cancellationInvoiceId);
  const originalNumber = useInvoiceNumber(invoice.cancelledInvoiceId);

  /**
   * Versenden und Erinnern — beides hinter dem zweiten Faktor.
   *
   * Erst OHNE Nachweis rufen: Bei einer Sitzung unter zehn Minuten lässt der
   * Server ihn weg. Erst wenn er ihn verlangt, klappt der Dialog auf, und der
   * Aufruf wird mit Nachweis wiederholt.
   *
   * Die Fehlermeldungen des Servers sind bereits für Menschen geschrieben
   * („Trage die E-Mail-Adresse an der Organisation nach …") — sie gehen im
   * Wortlaut in den Toast.
   */
  async function send(purpose: SendPurpose, evidence?: SecondFactorEvidence) {
    const texts = SEND_TEXT[purpose];
    const setLoading =
      purpose === 'send' ? setSendLoading : setReminderLoading;
    setLoading(true);
    setSendPurpose(purpose);
    try {
      onChanged(
        purpose === 'send'
          ? await sendInvoice(invoice.id, evidence)
          : await sendPaymentReminder(invoice.id, evidence),
      );
      evidenceState.close();
      setSendPurpose(null);
      toast.show(texts.success);
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setSendPurpose(null);
      toast.show(errorText(f, texts.error), 'error');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Der Weg zum Absenden: bei gelöschten Kontaktdaten erst die Nachfrage
   * ([H5]), sonst direkt.
   */
  function startSend(purpose: SendPurpose) {
    if (contactDataDeleted) {
      setWarningPurpose(purpose);
      return;
    }
    void send(purpose);
  }

  const cancelled = invoice.paymentState === 'cancelled';
  const alreadySent = invoice.status === 'sent';

  return (
    <>
      {invoice.cancellationInvoiceId !== null && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <Ban
            className="mt-0.5 h-5 w-5 shrink-0 text-leise"
            aria-hidden="true"
          />
          <p className="text-sm text-text">
            {t('components.invoiceView.text2')}{' '}
            <Link
              to={`/companies/${companyId}/invoices/${invoice.cancellationInvoiceId}`}
              className={TEXT_BUTTON}
            >
              <NumberSlot number={cancellationNumber} />
            </Link>
            {t('components.invoiceView.text3')}</p>
        </div>
      )}

      {invoice.isCancellation && invoice.cancelledInvoiceId !== null && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <Ban
            className="mt-0.5 h-5 w-5 shrink-0 text-leise"
            aria-hidden="true"
          />
          <p className="text-sm text-text">
            {t('components.invoiceView.text4')}{' '}
            <Link
              to={`/companies/${companyId}/invoices/${invoice.cancelledInvoiceId}`}
              className={TEXT_BUTTON}
            >
              <NumberSlot number={originalNumber} />
            </Link>
            {t('components.invoiceView.text3')}{invoice.cancellationReason !== null && (
              <> {t('components.invoiceView.text5')}{invoice.cancellationReason}</>
            )}
          </p>
        </div>
      )}

      <Card className="p-6">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('components.invoiceView.label')}>
            <span className="ziffern-tabellarisch">
              {formatDate(invoice.invoiceDate)}
            </span>
          </Field>
          <Field label={t('components.invoiceView.label2')}>
            <span className="ziffern-tabellarisch">
              {formatDate(invoice.dueDate)}
            </span>
          </Field>
          <Field label={t('components.invoiceView.label3')}>
            <span className="ziffern-tabellarisch">
              {formatDate(invoice.servicePeriodFrom)} –{' '}
              {formatDate(invoice.servicePeriodUntil)}
            </span>
          </Field>
          <Field label={t('components.invoiceView.label4')}>
            {invoice.finalizedAt !== null && (
              <span className="ziffern-tabellarisch">
                {formatDate(invoice.finalizedAt)}
              </span>
            )}
          </Field>
          {invoice.paymentDate !== null && (
            <Field label={t('components.invoiceView.label5')}>
              <span className="ziffern-tabellarisch">
                {formatDate(invoice.paymentDate)}
              </span>
            </Field>
          )}
          {invoice.paidAmount !== null && (
            <Field label={t('components.invoiceView.label6')}>
              <span className="ziffern-tabellarisch">
                {formatAmount(invoice.paidAmount)}
              </span>
              {t('components.invoiceView.text6')}
              <span className="ziffern-tabellarisch">
                {formatAmount(invoice.openAmount)}
              </span>
            </Field>
          )}
          {/* Der Empfängerteil ist ein SCHNAPPSCHUSS: Er wurde beim
              Festschreiben hineinkopiert und ändert sich nie wieder — auch
              nicht, wenn die Organisation umzieht. */}
          <Field label={t('components.invoiceView.label7')} wide>
            <p className="font-medium">{invoice.recipientName}</p>
            <p className="whitespace-pre-line text-leise">
              {invoice.recipientAddress}
            </p>
          </Field>
        </dl>
      </Card>

      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-lg font-semibold text-text">{t('components.invoiceView.heading')}</h2>
        <Table
          columns={[t('components.invoiceView.columns'), t('components.invoiceView.columns2'), t('components.invoiceView.columns3'), t('components.invoiceView.columns4'), t('components.invoiceView.columns5')]}
          label={t('components.invoiceView.label8')}
        >
          {invoice.lines.map((p) => (
            <tr key={p.id}>
              <td className={`${tableRow.compact} min-w-0`}>
                {p.label}
              </td>
              {/* NICHT roh: Der Server schickt „1.000" und meint EINS. */}
              <td className={`${tableRow.compact} ziffern-tabellarisch`}>
                {formatQuantity(p.quantity)}
              </td>
              <td className={`${tableRow.compact} ziffern-tabellarisch`}>
                {formatAmount(p.unitPriceNet)}
              </td>
              <td className={`${tableRow.compact} ziffern-tabellarisch`}>
                {formatPercent(p.taxRate)}
              </td>
              <td
                className={`${tableRow.compact} ziffern-tabellarisch font-medium`}
              >
                {formatAmount(p.grossAmount)}
              </td>
            </tr>
          ))}
        </Table>
        <dl className="mt-3 flex flex-col items-end gap-1 text-sm">
          <div className="flex gap-3">
            <dt className="text-leise">{t('components.invoiceView.text7')}</dt>
            <dd className="ziffern-tabellarisch">
              {formatAmount(invoice.sumNet)}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-leise">{t('components.invoiceView.text8')}</dt>
            <dd className="ziffern-tabellarisch">
              {formatAmount(invoice.sumTax)}
            </dd>
          </div>
          <div className="flex gap-3 text-base font-semibold">
            <dt>{t('components.invoiceView.text9')}</dt>
            <dd className="ziffern-tabellarisch">
              {formatAmount(invoice.sumGross)}
            </dd>
          </div>
        </dl>
      </Card>

      {/* GoBD: Integrität, Aufbewahrungsfrist und Verlauf (rein lesend). */}
      <InvoiceIntegrity
        invoiceId={invoice.id}
        finalized={invoice.finalizedAt !== null}
        retentionUntil={invoice.retentionUntil}
      />

      {/* Genau die fünf Handlungen einer festgeschriebenen Rechnung — keine
          mehr. Kein Bearbeiten, kein Löschen. */}
      {invoice.recipientBuyerType && (
        <p className="mt-6 text-sm text-leise">
          {t(
            invoice.recipientBuyerType === 'authority'
              ? 'components.invoiceView.hintAuthority'
              : invoice.recipientBuyerType === 'business'
                ? 'components.invoiceView.hintBusiness'
                : 'components.invoiceView.hintConsumer',
          )}
        </p>
      )}
      <div
        className={
          invoice.recipientBuyerType
            ? 'mt-2 flex flex-wrap gap-3'
            : 'mt-6 flex flex-wrap gap-3'
        }
      >
        {/* ES BLEIBT EIN `<a href>`, und zwar mit Absicht: Mittelklick,
            „Link in neuem Tab öffnen" und ein Browser ohne Skript
            funktionieren damit unverändert. Der Klick wird nur ABGEFANGEN,
            um die Antwort zu prüfen, bevor sich ein Tab öffnet.

            Vorher öffnete sich im Fehlerfall ein Tab mit dem rohen JSON des
            Servers — gemessen, als der Rechnungsdienst nicht lief. Die
            Meldung darin ist für Menschen geschrieben; sie stand nur an
            einer Stelle, an der sie niemand lesen soll. */}
        <a
          href={`/api/invoices/${invoice.id}/document`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => fetch(ev, 'document', 'pdf')}
          className={BUTTON_SECONDARY_AS_LINK}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t('components.invoiceView.text10')}</a>
        <a
          href={`/api/invoices/${invoice.id}/xml`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => fetch(ev, 'xml', 'xml')}
          className={BUTTON_SECONDARY_AS_LINK}
        >
          <FileCode className="h-4 w-4" aria-hidden="true" />
          {t('components.invoiceView.text11')}</a>
        <a
          href={`/api/invoices/${invoice.id}/xrechnung`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => fetch(ev, 'xrechnung', 'xml')}
          className={BUTTON_SECONDARY_AS_LINK}
        >
          <FileCode className="h-4 w-4" aria-hidden="true" />
          {t('components.invoiceView.xrechnung')}</a>

        {!cancelled && (
          <Button
            variant="secondary"
            loading={sendLoading}
            onClick={() => startSend('send')}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {alreadySent ? t('components.invoiceView.button') : t('components.invoiceView.button2')}
          </Button>
        )}

        {(invoice.paymentState === 'overdue' ||
          invoice.paymentState === 'partially_paid') && (
          <Button
            variant="secondary"
            loading={reminderLoading}
            onClick={() => startSend('reminder')}
          >
            <MailWarning className="h-4 w-4" aria-hidden="true" />
            {t('components.invoiceView.button3')}</Button>
        )}

        {invoice.paymentState !== 'paid' && !cancelled && (
          <Button
            variant="secondaryGreen"
            onClick={() => setPaymentOpen(true)}
          >
            <Landmark className="h-4 w-4" aria-hidden="true" />
            {t('components.invoiceView.button4')}</Button>
        )}

        {/* Kein Stornieren-Knopf an einer Stornorechnung und keiner an einer
            bereits stornierten: Ein Knopf, der immer scheitert, ist der
            schlechteste Weg, eine Regel zu erklären. */}
        {!cancelled &&
          !invoice.isCancellation &&
          invoice.cancellationInvoiceId === null && (
            <Button variant="danger" onClick={() => setCancellationOpen(true)}>
              <Ban className="h-4 w-4" aria-hidden="true" />
              {t('components.invoiceView.button5')}</Button>
          )}
      </div>

      {alreadySent && (
        <p className="mt-3 text-sm text-leise">
          {t('components.invoiceView.text12')}</p>
      )}

      {/* [H5] Steht da, BEVOR jemand auf „Versenden" drückt — die Nachfrage im
          Dialog kommt danach und ist die zweite Stufe, nicht die erste. */}
      {contactDataDeleted && !cancelled && (
        <p className="mt-3 text-sm text-leise">
          {t('components.invoiceView.text13')}</p>
      )}

      {!cancelled && (
        <div className="mt-6 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <p className="mb-2 text-sm font-medium text-text">
            {t('components.invoiceView.text14')}</p>
          <p className="text-sm text-leise">
            {invoice.transferStatus ?? t('components.invoiceView.text15')}
          </p>
          <button
            type="button"
            className={`mt-2 text-sm ${TEXT_BUTTON_ACTION}`}
            onClick={() => setTransferOpen(true)}
          >
            {invoice.transferStatus !== null
              ? t('components.invoiceView.button6')
              : t('components.invoiceView.button7')}
          </button>
        </div>
      )}

      <PaymentRecordDialog
        open={paymentOpen}
        invoice={invoice}
        totpPossible={totpPossible}
        onClose={() => setPaymentOpen(false)}
        onNoted={(updated) => {
          setPaymentOpen(false);
          onChanged(updated);
          toast.show(t('components.invoiceView.text16'));
        }}
      />

      <TransferNoteDialog
        open={transferOpen}
        invoice={invoice}
        totpPossible={totpPossible}
        onClose={() => setTransferOpen(false)}
        onNoted={(updated) => {
          setTransferOpen(false);
          onChanged(updated);
          toast.show(t('components.invoiceView.text17'));
        }}
      />

      <InvoiceCancelDialog
        open={cancellationOpen}
        invoice={invoice}
        totpPossible={totpPossible}
        onClose={() => setCancellationOpen(false)}
        onCancelled={(result) => {
          setCancellationOpen(false);
          onCancelled(result);
        }}
      />

      {/* [H5] Die Nachfrage nach der Kontaktdatenlöschung.
          KEINE SPERRE: Es kann Gründe geben, eine bereits ausgestellte
          Rechnung noch zuzustellen — die Forderung besteht ja weiter, und das
          Aufbewahren des Schnappschusses ist ausdrücklich richtig. Was nicht
          von selbst passieren darf, ist ein NEUER Versand an eine Adresse,
          deren Löschung verlangt wurde. Also: nachfragen, mit Adresse. */}
      <Dialog
        open={warningPurpose !== null}
        title={t('components.invoiceView.title3')}
        size="sm"
        onClose={() => setWarningPurpose(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setWarningPurpose(null)}>
              {t('components.invoiceView.button8')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const purpose = warningPurpose;
                setWarningPurpose(null);
                if (purpose) void send(purpose);
              }}
            >
              {t('components.invoiceView.button9')}</Button>
          </>
        }
      >
        <p className="text-sm text-text">
          {t('components.invoiceView.text18')}</p>
        {invoice.recipientEmail !== null && (
          <p className="mt-3 text-sm text-text">
            {t('components.invoiceView.text19')}{' '}
            <span className="font-medium">{invoice.recipientEmail}</span>.
          </p>
        )}
        <p className="mt-3 text-sm text-leise">
          {t('components.invoiceView.text20')}</p>
      </Dialog>

      {/* Als LETZTES im Baum: Beide Overlays tragen `z-50`, es entscheidet die
          DOM-Reihenfolge. Der Nachweis-Dialog muss über allem liegen, was ihn
          ausgelöst haben kann. */}
      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={SEND_TEXT[sendPurpose ?? 'send'].title}
        declaration={SEND_TEXT[sendPurpose ?? 'send'].declaration}
        totpPossible={totpPossible}
        loading={sendLoading || reminderLoading}
        error={evidenceState.error}
        onCancel={() => {
          evidenceState.close();
          setSendPurpose(null);
        }}
        onConfirm={(evidence) => {
          if (sendPurpose) void send(sendPurpose, evidence);
        }}
      />
    </>
  );
}
