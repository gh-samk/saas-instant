import { useState, type ReactNode } from 'react';
import { Dialog, Button, useToast } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  sendPaymentReminder,
  sendInvoice,
  type Invoice,
  type SecondFactorEvidence,
} from '../lib/api';
import { formatAmount } from '../utils/amount';
import { t, useT } from '../i18n';

/** Wofür gerade ein Nachweis verlangt wird — der Dialog ist derselbe. */
export type SendPurpose = 'send' | 'reminder';

const SEND_TEXT: Record<
  SendPurpose,
  { title: string; declaration: string; success: string; error: string }
> = {
  send: {
    title: t('components.invoiceView.title'),
    declaration: t('components.invoiceView.declaration'),
    success: t('components.invoiceView.success'),
    error: t('components.invoiceView.error'),
  },
  reminder: {
    title: t('components.invoiceView.title2'),
    declaration: t('components.invoiceView.declaration2'),
    success: t('components.invoiceView.success2'),
    error: t('components.invoiceView.error2'),
  },
};

/**
 * Der Versandablauf einer festgeschriebenen Rechnung — herausgelöst aus der
 * Rechnungsansicht, damit auch Listenzeilen („Zahlungserinnerung senden")
 * ihn auslösen können, ohne die Detailseite zu öffnen.
 *
 * Alles, was der Ablauf braucht, steht im `invoice`-Objekt: Empfänger
 * (`recipientName`, `recipientEmail`), Nummer, Beträge (`sumGross`,
 * `openAmount`) und `status` (erneut versenden?). Der Aufrufer liefert nur
 * zwei Umgebungsangaben, die nicht an der Rechnung hängen: ob die
 * Kontaktdaten der Organisation gelöscht wurden und ob ein zweiter Faktor
 * eingerichtet ist.
 *
 * Der Ablauf (Verhalten unverändert gegenüber der früheren Fassung in
 * `InvoiceView`):
 * 1. `start(purpose)` fragt nach. Bei gelöschten Kontaktdaten [H5] fragt die
 *    Warnung (mit Adresse) und ersetzt die Bestätigung; sonst bestätigt ein
 *    Dialog Empfänger und Betrag. Eine Mail lässt sich nicht zurückholen,
 *    also nie mit einem einzigen Klick.
 * 2. Erst nach der Bestätigung wird OHNE Nachweis gerufen: Bei einer Sitzung
 *    unter zehn Minuten lässt der Server ihn weg. Verlangt er ihn, klappt der
 *    Nachweis-Dialog auf, und der Aufruf wird mit Nachweis wiederholt.
 * 3. Der Erfolg geht über `onChanged(invoice)` zurück; Fehler erscheinen als
 *    Toast im Wortlaut des Servers.
 *
 * `element` muss im Baum stehen (es enthält die drei Dialoge); es braucht
 * einen `ToastProvider` oberhalb.
 */
export function useInvoiceSendFlow({
  invoice,
  contactDataDeleted,
  totpPossible,
  onChanged,
}: {
  invoice: Invoice;
  /** [H5] Wurden die Kontaktdaten der Organisation gelöscht? */
  contactDataDeleted: boolean;
  totpPossible: boolean;
  onChanged: (invoice: Invoice) => void;
}): {
  start: (purpose: SendPurpose) => void;
  element: ReactNode;
  /** Läuft gerade irgendein Versand? */
  loading: boolean;
  /** Wofür er läuft — damit nur der passende Knopf den Spinner zeigt. */
  loadingPurpose: SendPurpose | null;
} {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [loadingPurpose, setLoadingPurpose] = useState<SendPurpose | null>(null);
  const [sendPurpose, setSendPurpose] = useState<SendPurpose | null>(null);
  const [warningPurpose, setWarningPurpose] = useState<SendPurpose | null>(null);
  const [confirmPurpose, setConfirmPurpose] = useState<SendPurpose | null>(null);
  const alreadySent = invoice.status === 'sent';

  /**
   * Versenden und Erinnern — beides hinter dem zweiten Faktor.
   *
   * Die Fehlermeldungen des Servers sind bereits für Menschen geschrieben
   * („Trage die E-Mail-Adresse an der Organisation nach …") — sie gehen im
   * Wortlaut in den Toast.
   */
  async function send(purpose: SendPurpose, evidence?: SecondFactorEvidence) {
    const texts = SEND_TEXT[purpose];
    setLoadingPurpose(purpose);
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
      setLoadingPurpose(null);
    }
  }

  function start(purpose: SendPurpose) {
    if (contactDataDeleted) {
      setWarningPurpose(purpose);
      return;
    }
    setConfirmPurpose(purpose);
  }

  // Die Bestätigung vor dem Versand. Empfänger und Betrag kommen aus dem
  // Schnappschuss der Rechnung — genau dorthin schickt der Server
  // (`recipientEmail` der Rechnung, nicht die aktuelle Kontaktadresse der
  // Organisation). Ohne Adresse lehnt der Server ohnehin ab; dann ist der
  // Knopf gesperrt. Bei der Erinnerung zählt der OFFENE Betrag, beim Versand
  // die Bruttosumme.
  const reminder = confirmPurpose === 'reminder';
  const email = invoice.recipientEmail;
  const missingEmail = email === null || email.trim() === '';
  const confirmTitle = reminder
    ? t('components.invoiceView.confirmTitleReminder')
    : alreadySent
      ? t('components.invoiceView.confirmTitleResend')
      : t('components.invoiceView.confirmTitleSend');

  const element = (
    <>
      <Dialog
        open={confirmPurpose !== null}
        title={confirmTitle}
        size="sm"
        onClose={() => setConfirmPurpose(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmPurpose(null)}>
              {t('components.invoiceView.button8')}
            </Button>
            <Button
              variant="primary"
              disabled={missingEmail}
              onClick={() => {
                const purpose = confirmPurpose;
                setConfirmPurpose(null);
                if (purpose) void send(purpose);
              }}
            >
              {reminder
                ? t('components.invoiceView.confirmReminder')
                : t('components.invoiceView.confirmSend')}
            </Button>
          </>
        }
      >
        <dl className="space-y-2 text-sm text-text">
          <div>
            <dt className="text-leise">{t('components.invoiceView.confirmRecipient')}</dt>
            <dd className="font-medium">{invoice.recipientName}</dd>
            {!missingEmail && <dd className="font-medium">{email}</dd>}
          </div>
          <div>
            <dt className="text-leise">{t('components.invoiceView.confirmInvoiceNumber')}</dt>
            <dd className="font-medium">{invoice.invoiceNumber}</dd>
          </div>
          <div>
            <dt className="text-leise">
              {reminder
                ? t('components.invoiceView.confirmOpenAmount')
                : t('components.invoiceView.confirmAmount')}
            </dt>
            <dd className="ziffern-tabellarisch font-medium">
              {formatAmount(reminder ? invoice.openAmount : invoice.sumGross)}
            </dd>
          </div>
        </dl>
        {missingEmail && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {t('components.invoiceView.confirmNoEmail')}
          </p>
        )}
      </Dialog>

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
              {t('components.invoiceView.button8')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const purpose = warningPurpose;
                setWarningPurpose(null);
                if (purpose) void send(purpose);
              }}
            >
              {t('components.invoiceView.button9')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text">{t('components.invoiceView.text18')}</p>
        {invoice.recipientEmail !== null && (
          <p className="mt-3 text-sm text-text">
            {t('components.invoiceView.text19')}{' '}
            <span className="font-medium">{invoice.recipientEmail}</span>.
          </p>
        )}
        <p className="mt-3 text-sm text-leise">{t('components.invoiceView.text20')}</p>
      </Dialog>

      {/* Als LETZTES im Baum: Alle Overlays tragen `z-50`, es entscheidet die
          DOM-Reihenfolge. Der Nachweis-Dialog muss über allem liegen, was ihn
          ausgelöst haben kann. */}
      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={SEND_TEXT[sendPurpose ?? 'send'].title}
        declaration={SEND_TEXT[sendPurpose ?? 'send'].declaration}
        totpPossible={totpPossible}
        loading={loadingPurpose !== null}
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

  return {
    start,
    element,
    loading: loadingPurpose !== null,
    loadingPurpose,
  };
}
