import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Ban,
  Download,
  Landmark,
  MailWarning,
  MoreHorizontal,
  Send,
} from 'lucide-react';
import {
  Card,
  Button,
  Menu,
  Table,
  useToast,
  type MenuItem,
} from '@saas-instant/ui';
import { Field } from './DetailBlock';
import { InvoiceCancelDialog } from './InvoiceCancelDialog';
import { TransferNoteDialog } from './TransferNoteDialog';
import { PaymentRecordDialog } from './PaymentRecordDialog';
import {
  InvoiceIntegrity,
  IntegrityStatusBadge,
  localStamp,
  useInvoiceIntegrity,
} from './InvoiceIntegrity';
import { useInvoiceSendFlow } from './InvoiceSendFlow';
import { apiFile, errorText } from '../lib/api-client';
import { tableRow } from '../lib/density';
import { TEXT_BUTTON, TEXT_BUTTON_ACTION } from '../lib/styles';
import {
  fetchInvoice,
  type BuyerType,
  type Invoice,
  type InvoiceWithRetention,
} from '../lib/api';
import { formatAmount } from '../utils/amount';
import { formatQuantity, formatPercent } from '../utils/decimal';
import { formatDate } from '../utils/date';
import { useMediaQuery } from '../lib/use-media-query';
import { useT } from '../i18n';

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

type DownloadWay = 'document' | 'xml' | 'xrechnung';

/**
 * Die Download-Varianten in der Reihenfolge, die zur Empfängerart passt: Die
 * empfohlene steht oben und ist markiert. Eine Behörde bekommt die XRechnung
 * (das PDF allein genügt dort nicht), Unternehmen und Privatpersonen das
 * ZUGFeRD-PDF. Ohne bekannte Art gibt es keine Empfehlung — raten wäre
 * schlimmer als schweigen.
 */
export function downloadOrder(
  buyerType: BuyerType | null | undefined,
): { way: DownloadWay; recommended: boolean }[] {
  const order: DownloadWay[] =
    buyerType === 'authority'
      ? ['xrechnung', 'document', 'xml']
      : ['document', 'xrechnung', 'xml'];
  return order.map((way, index) => ({
    way,
    recommended: buyerType != null && index === 0,
  }));
}

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
  header,
}: {
  /**
   * Titel, Status und Organisation der Kopfzeile — kommen von der Seite. Die
   * Ansicht setzt Integritäts-Abzeichen und Aktionsleiste daneben, damit
   * alles, was man mit der Rechnung tun kann, ohne Scrollen erreichbar ist.
   */
  header?: ReactNode;
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
  // Ab `sm` die Postentabelle, darunter Karten (sonst laufen Einzelpreis, Steuer
  // und Brutto bei 375 px aus der Karte). Eine Darstellung je Breite, nie beide.
  const isWide = useMediaQuery('(min-width: 640px)');

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
    event: React.MouseEvent<HTMLElement>,
    weg: DownloadWay,
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
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [cancellationOpen, setCancellationOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const cancellationNumber = useInvoiceNumber(invoice.cancellationInvoiceId);
  const originalNumber = useInvoiceNumber(invoice.cancelledInvoiceId);

  // Der Versandablauf (Bestätigung, [H5]-Nachfrage, Zweitfaktor) steht in
  // einer eigenen Komponente, damit Listen ihn ebenfalls auslösen können.
  const sendFlow = useInvoiceSendFlow({
    invoice,
    contactDataDeleted,
    totpPossible,
    onChanged,
  });
  const integrityState = useInvoiceIntegrity(
    invoice.id,
    invoice.finalizedAt !== null,
    `${invoice.status}|${invoice.paymentState}|${invoice.transferStatus ?? ''}`,
  );

  const cancelled = invoice.paymentState === 'cancelled';
  const alreadySent = invoice.status === 'sent';

  // GENAU EINE HAUPTAKTION JE STATUS. Eine festgeschriebene, nie versendete
  // Rechnung will zuerst hinaus („Versenden"); danach ist offen, was fehlt: die
  // Zahlung. Bezahlt oder storniert gibt es nichts Dringendes mehr, dann
  // bleiben nur Nebenaktionen. Alles andere sind Sekundärknöpfe, und das
  // Stornieren liegt im Menü „Weitere": nie als roter Knopf neben der Zahlung.
  const canPay = invoice.paymentState !== 'paid' && !cancelled;
  const sendIsPrimary = !cancelled && invoice.status === 'finalized';
  const payIsPrimary = canPay && !sendIsPrimary;
  const canReminder =
    invoice.paymentState === 'overdue' ||
    invoice.paymentState === 'partially_paid';
  // Kein Stornieren an einer Stornorechnung und keins an einer bereits
  // stornierten: Ein Knopf, der immer scheitert, ist der schlechteste Weg,
  // eine Regel zu erklären.
  const canCancel =
    !cancelled &&
    !invoice.isCancellation &&
    invoice.cancellationInvoiceId === null;

  const downloadItems: MenuItem[] = downloadOrder(invoice.recipientBuyerType).map(
    ({ way, recommended }) => {
      const key =
        way === 'document' ? 'Document' : way === 'xrechnung' ? 'Xrechnung' : 'Xml';
      return {
        id: way,
        // Es BLEIBT ein `<a href>`, und zwar mit Absicht: Mittelklick, „Link
        // in neuem Tab öffnen" und ein Browser ohne Skript funktionieren
        // damit unverändert. Der Klick wird nur ABGEFANGEN, um die Antwort zu
        // prüfen, bevor sich ein Tab öffnet — im Fehlerfall stünde sonst das
        // rohe JSON des Servers in einem neuen Tab.
        href: `/api/invoices/${invoice.id}/${way}`,
        label: t(`components.invoiceView.download${key}`),
        description: t(`components.invoiceView.download${key}Hint`),
        badge: recommended
          ? t('components.invoiceView.downloadRecommended')
          : undefined,
        onSelect: (ev) => void fetch(ev, way, way === 'document' ? 'pdf' : 'xml'),
      };
    },
  );

  const moreItems: MenuItem[] = canCancel
    ? [
        {
          id: 'cancel',
          label: t('components.invoiceView.button5'),
          description: t('components.invoiceView.cancelHint'),
          tone: 'danger',
          onSelect: () => setCancellationOpen(true),
        },
      ]
    : [];

  const transferDate = (integrityState.history ?? [])
    .filter((e) => e.action === 'invoice.transfer.noted')
    .map((e) => e.at)
    .sort()
    .pop();

  const sendButton = !cancelled && (
    <Button
      variant={sendIsPrimary ? 'primary' : 'ghost'}
      loading={sendFlow.loadingPurpose === 'send'}
      onClick={() => sendFlow.start('send')}
    >
      <Send className="h-4 w-4" aria-hidden="true" />
      {alreadySent
        ? t('components.invoiceView.button')
        : t('components.invoiceView.button2')}
    </Button>
  );

  return (
    <>
      {/* KOPFZEILE: Titel und Status links, Aktionen rechts. Die Leiste
          bricht um (375 px), statt seitlich überzulaufen. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {header}
          <div className="mt-2">
            <IntegrityStatusBadge state={integrityState} />
          </div>
        </div>
        <div
          role="group"
          aria-label={t('components.invoiceView.actionsLabel')}
          className="flex min-w-0 max-w-full flex-wrap items-center gap-2"
        >
          {sendIsPrimary && sendButton}
          {payIsPrimary && (
            <Button variant="primary" onClick={() => setPaymentOpen(true)}>
              <Landmark className="h-4 w-4" aria-hidden="true" />
              {t('components.invoiceView.button4')}
            </Button>
          )}
          {!sendIsPrimary && sendButton}
          {canReminder && !cancelled && (
            <Button
              variant="ghost"
              loading={sendFlow.loadingPurpose === 'reminder'}
              onClick={() => sendFlow.start('reminder')}
            >
              <MailWarning className="h-4 w-4" aria-hidden="true" />
              {/* „Mahnung" als kleiner Zusatz in derselben Zeile: gleiche Höhe
                  wie die übrigen Knöpfe, und wer danach sucht, findet das Wort
                  trotzdem. */}
              <span>{t('components.invoiceView.button3')}</span>
              <span className="text-xs font-normal text-leise">
                ({t('components.invoiceView.reminderSubtitle')})
              </span>
            </Button>
          )}
          {canPay && !payIsPrimary && (
            <Button variant="secondary" onClick={() => setPaymentOpen(true)}>
              <Landmark className="h-4 w-4" aria-hidden="true" />
              {t('components.invoiceView.button4')}
            </Button>
          )}
          <Menu
            label={t('components.invoiceView.download')}
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            items={downloadItems}
          />
          {moreItems.length > 0 && (
            <Menu
              label={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
              ariaLabel={t('components.invoiceView.more')}
              hideChevron
              items={moreItems}
            />
          )}
        </div>
      </div>

      {alreadySent && (
        <p className="mb-4 text-sm text-leise">
          {t('components.invoiceView.text12')}
        </p>
      )}

      {/* [H5] Steht da, BEVOR jemand auf „Versenden" drückt — die Nachfrage im
          Dialog kommt danach und ist die zweite Stufe, nicht die erste. */}
      {contactDataDeleted && !cancelled && (
        <p className="mb-4 text-sm text-leise">
          {t('components.invoiceView.text13')}
        </p>
      )}

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
        {isWide ? (
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
        ) : (
        <ul
          aria-label={t('components.invoiceView.label8')}
          className="divide-y divide-rahmen overflow-hidden rounded-lg border border-rahmen"
        >
          {invoice.lines.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-medium text-text">
                  {p.label}
                </span>
                <span className="shrink-0 text-sm font-semibold text-text ziffern-tabellarisch">
                  {formatAmount(p.grossAmount)}
                </span>
              </div>
              <p className="text-xs text-leise ziffern-tabellarisch">
                {formatQuantity(p.quantity)} × {formatAmount(p.unitPriceNet)}
                {' · '}
                {t('components.invoiceView.columns4')} {formatPercent(p.taxRate)}
              </p>
            </li>
          ))}
        </ul>
        )}
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

      {/* Buchhaltung: eine verständliche Zeile statt eines Kastens. Der
          Vermerk ist Freitext (kein Datum am Rechnungsobjekt); das Datum
          stammt aus dem Verlauf, sofern er es kennt. Der Weg bleibt der
          Dialog mit Zweitfaktor. */}
      {!cancelled && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <p className="min-w-0 text-sm text-text">
            <span className="font-medium">
              {t('components.invoiceView.transferTitle')}
            </span>
            {': '}
            <span className="text-leise">
              {invoice.transferStatus !== null
                ? transferDate
                  ? `${invoice.transferStatus} (${localStamp(transferDate)})`
                  : invoice.transferStatus
                : t('components.invoiceView.transferNot')}
            </span>
          </p>
          <button
            type="button"
            className={`text-sm ${TEXT_BUTTON_ACTION}`}
            onClick={() => setTransferOpen(true)}
          >
            {invoice.transferStatus !== null
              ? t('components.invoiceView.button6')
              : t('components.invoiceView.transferMark')}
          </button>
        </div>
      )}

      {/* GoBD: Integrität, Aufbewahrungsfrist und Verlauf (rein lesend,
          eingeklappt; das Ergebnis steht als Abzeichen in der Kopfzeile). */}
      <InvoiceIntegrity
        invoiceId={invoice.id}
        finalized={invoice.finalizedAt !== null}
        retentionUntil={invoice.retentionUntil}
        state={integrityState}
        showBadge={false}
      />

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

      {sendFlow.element}
    </>
  );
}
