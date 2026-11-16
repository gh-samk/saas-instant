import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { Button, useToast } from '@saas-instant/ui';
import { PaymentRecordDialog } from './PaymentRecordDialog';
import { useInvoiceSendFlow } from './InvoiceSendFlow';
import { useAuth } from '../context/AuthContext';
import { errorText } from '../lib/api-client';
import {
  fetchInvoice,
  NAME_AFTER_CONTACT_DATA_DELETION,
  type Invoice,
  type Task,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * Die Direktaktionen einer Rechnung („Zahlung erfassen", „Zahlungserinnerung
 * senden") für Stellen, die nicht die Rechnungsseite sind: Zeilen der
 * Rechnungsliste und der Startseite.
 *
 * Sie öffnen dieselben Dialoge wie die Rechnungsansicht — Bestätigung mit
 * Empfänger und Betrag, [H5]-Warnung, zweiter Faktor — und lösen nichts mit
 * einem einzigen Klick aus. Eine Erinnerung ist eine Mail, die sich nicht
 * zurückholen lässt, eine Zahlung löscht still eine Forderung aus der
 * Übersicht.
 *
 * `contactDataDeleted` folgt wie in der Rechnungsansicht aus dem Namen der
 * Organisation: Nach der Löschung der Kontaktdaten steht dort der feste
 * Ersatzname, und die Rechnung trägt ihn als `companyName`.
 *
 * `element` muss im Baum stehen (es enthält die Dialoge).
 */
export function useInvoiceQuickActions({
  invoice,
  onChanged,
}: {
  invoice: Invoice;
  onChanged: (invoice: Invoice) => void;
}): {
  recordPayment: () => void;
  sendReminder: () => void;
  /** Läuft gerade der Versand der Erinnerung? */
  reminderRunning: boolean;
  element: ReactNode;
} {
  const { state } = useAuth();
  const toast = useToast();
  const t = useT();
  const totpPossible = state?.totpSetUp ?? false;
  const [paymentOpen, setPaymentOpen] = useState(false);
  const sendFlow = useInvoiceSendFlow({
    invoice,
    contactDataDeleted: invoice.companyName === NAME_AFTER_CONTACT_DATA_DELETION,
    totpPossible,
    onChanged,
  });

  return {
    recordPayment: () => setPaymentOpen(true),
    sendReminder: () => sendFlow.start('reminder'),
    reminderRunning: sendFlow.loadingPurpose === 'reminder',
    element: (
      <>
        {sendFlow.element}
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
      </>
    ),
  };
}

type Purpose = 'payment' | 'reminder';

/**
 * Hält die Dialoge einer nachgeladenen Rechnung und stößt beim Einhängen
 * (bzw. bei jeder neuen Anforderung) den gewünschten Ablauf an. Die Rechnung
 * liegt erst nach dem Klick vor; der Hook braucht aber von Anfang an eine.
 */
function QuickActionHost({
  invoice,
  request,
  onChanged,
}: {
  invoice: Invoice;
  request: { purpose: Purpose; id: number };
  onChanged: (invoice: Invoice) => void;
}) {
  const actions = useInvoiceQuickActions({ invoice, onChanged });
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (request.purpose === 'payment') latest.current.recordPayment();
    else latest.current.sendReminder();
  }, [request]);
  return <>{actions.element}</>;
}

/**
 * Die Zeilenknöpfe einer überfälligen Rechnung auf „Heute".
 *
 * DIE AUFGABE TRÄGT NUR DIE KENNUNG DER RECHNUNG, nicht Empfänger, Adresse und
 * Beträge: Die Aufgabenliste soll nicht für jede Rechnung ein halbes
 * Rechnungsobjekt mitschleppen. Beim Klick wird sie deshalb frisch geladen
 * (Knopf zeigt den Ladezustand) — das ist zugleich die richtige Stelle, den
 * aktuellen Stand zu holen: Ist sie inzwischen bezahlt, sieht man es VOR dem
 * Dialog, nicht erst im Fehler danach.
 */
export function TaskInvoiceActions({
  task,
  onChanged,
}: {
  task: Task;
  /** Nach Zahlung oder Erinnerung: Die Aufgabenliste neu laden (Betrag, Wegfall). */
  onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [request, setRequest] = useState<{ purpose: Purpose; id: number } | null>(
    null,
  );
  const [loading, setLoading] = useState<Purpose | null>(null);
  const counter = useRef(0);
  const invoiceId = task.invoiceId;
  if (!invoiceId) return null;

  async function open(purpose: Purpose) {
    if (!invoiceId || loading !== null) return;
    setLoading(purpose);
    try {
      const loaded = await fetchInvoice(invoiceId);
      setInvoice(loaded);
      counter.current += 1;
      setRequest({ purpose, id: counter.current });
    } catch (f) {
      toast.show(errorText(f, t('dashboard.invoiceLoadFailed')), 'error');
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      {/* NICHT `disabled`/`loading` während des Nachladens: Ein deaktivierter
          Knopf verliert den Fokus, und der Dialog gäbe ihn beim Schließen an
          <body> zurück. `aria-busy` meldet den Zustand, der Klick wird in
          `open` abgefangen. */}
      <Button
        size="sm"
        variant="primary"
        aria-busy={loading === 'payment' || undefined}
        onClick={() => void open('payment')}
      >
        {loading === 'payment' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        )}
        {t('dashboard.recordPayment')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        aria-busy={loading === 'reminder' || undefined}
        onClick={() => void open('reminder')}
      >
        {loading === 'reminder' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Mail className="h-4 w-4" aria-hidden="true" />
        )}
        {t('dashboard.sendReminder')}
      </Button>
      {invoice !== null && request !== null && (
        <QuickActionHost
          invoice={invoice}
          request={request}
          onChanged={(updated) => {
            setInvoice(updated);
            onChanged();
          }}
        />
      )}
    </>
  );
}
