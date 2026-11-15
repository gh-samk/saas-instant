import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, SearchX } from 'lucide-react';
import { EmptyState, Skeleton, useToast } from '@saas-instant/ui';
import { InvoiceView } from '../components/InvoiceView';
import { InvoiceDraftForm } from '../components/InvoiceDraftForm';
import { NoticeBar } from '@saas-instant/ui';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge';
import { useAuth } from '../context/AuthContext';
import { errorText } from '../lib/api-client';
import { TEXT_BUTTON, TEXT_BUTTON_ACTION } from '../lib/styles';
import {
  fetchCompany,
  fetchPriceSuggestion,
  fetchInvoice,
  NAME_AFTER_CONTACT_DATA_DELETION,
  type Company,
  type PriceSuggestion,
  type Invoice,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * Das Wortzeichen für „diese Rechnung gibt es noch nicht".
 *
 * ZWEI ROUTEN, UND DER SCHNITT LIEGT GENAU HIER.
 *
 * Seit es die globale Rechnungsliste gibt, ist eine Rechnung ein Gegenstand
 * für sich: `/invoices/:invoiceId`. Die Organisation ergibt sich aus ihr,
 * nicht aus dem Pfad. Die alte, organisationsgebundene Form bleibt gültig und
 * leitet dorthin weiter — kein Lesezeichen und kein Aufgabenziel bricht.
 *
 * DIE NEUANLAGE KANN DAS NICHT. Ein Entwurf, den es noch nicht gibt, hat
 * keine Organisation, aus der sie sich ergäbe — sie MUSS im Pfad stehen.
 * Deshalb bleibt `/companies/:id/invoices/new`, und nur dieser Fall
 * liest die Organisation aus der Route.
 */
const NEW_SEGMENT = 'new';

/**
 * Rechnungsentwurf anlegen, ansehen, festschreiben, stornieren.
 *
 * KEIN DIALOG, SONDERN EINE SEITE. Ein Rechnungsentwurf ist zu groß für ein
 * Modal: bis zu 50 Posten, ein Vorschlagsblock mit Begründungstext,
 * editierbare Kopfdaten. Ein Dialog, der bei 375 px eine Postentabelle mit
 * waagerechtem Scroll enthält, ist genau die Bauform, die in Etappe 2
 * zurückgewiesen wurde.
 *
 * WELCHE ANSICHT ERSCHEINT, ENTSCHEIDET `status` — die rohe Spalte —, NICHT
 * `zahlungsstand`. Das ist der eine Ort, an dem `status` richtig ist: Er sagt,
 * was MÖGLICH ist. `zahlungsstand` sagt, was DASTEHT, und erscheint deshalb
 * ausschließlich im Abzeichen.
 */
export function InvoiceDetailPage() {
  const t = useT();
  const { id: companyFromPath = '', invoiceId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { state } = useAuth();
  const totpPossible = state?.totpSetUp ?? false;

  const isNew = invoiceId === NEW_SEGMENT;

  const [company, setCompany] = useState<Company | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [suggestion, setSuggestion] = useState<PriceSuggestion | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoaded(false);
    setLoadError(null);
    try {
      if (isNew) {
        // Neuanlage: Die Organisation steht im Pfad, eine Rechnung gibt es
        // noch nicht.
        setCompany(await fetchCompany(companyFromPath));
        setInvoice(null);
      } else {
        // Bestand: ERST die Rechnung, dann ihre Organisation. Nacheinander,
        // nicht nebenläufig — welche Organisation zu laden ist, steht in der
        // Rechnung. Das ist der Preis dafür, dass der Pfad sie nicht mehr
        // nennen muss.
        const r = await fetchInvoice(invoiceId);
        setInvoice(r);
        setCompany(await fetchCompany(r.companyId));
      }
    } catch (f) {
      setLoadError(errorText(f, t('rechnungen.loadInvoiceFailed')));
    } finally {
      setLoaded(true);
    }
  }, [companyFromPath, invoiceId, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  // Der Preisvorschlag ist eine EIGENE, unabhängige Abfrage: Schlägt sie fehl,
  // bleibt das Anlegen einer Rechnung möglich — Posten lassen sich immer von
  // Hand eintragen. Ein Seitenabbruch dafür wäre unverhältnismäßig.
  const draftMode = isNew || invoice?.status === 'draft';
  // Die Kennung der Organisation: aus dem Pfad, solange es die Rechnung noch
  // nicht gibt — danach aus der Rechnung selbst.
  const companyId = isNew
    ? companyFromPath
    : (invoice?.companyId ?? '');
  useEffect(() => {
    if (!draftMode || companyId === '') return;
    let alive = true;
    setSuggestionError(null);
    void fetchPriceSuggestion(companyId)
      .then((v) => {
        if (alive) setSuggestion(v);
      })
      .catch((f: unknown) => {
        if (alive) {
          setSuggestionError(
            errorText(f, t('rechnungen.loadSuggestionFailed')),
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [draftMode, companyId]);

  if (!loaded) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (loadError !== null || company === null) {
    return (
      <EmptyState
        Icon={SearchX}
        title={t('rechnungen.notFoundTitle')}
        notice={loadError ?? t('rechnungen.notFoundHint')}
        action={
          <Link
            to={`/companies/${companyId}`}
            className={`text-sm ${TEXT_BUTTON}`}
          >
            {t('rechnungen.backToCompany')}
          </Link>
        }
      />
    );
  }

  return (
    <div>
      {/* ZURÜCK ZUR RECHNUNGSLISTE, nicht zur Organisation. Wer aus einem
          Abrechnungslauf kommt, will dorthin zurück. Der Weg zur Organisation
          steht daneben im Kopf — er ist eine zweite Richtung, kein Ersatz. */}
      <Link to="/invoices" className={`mb-2 text-sm ${TEXT_BUTTON_ACTION}`}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('rechnungen.toAllInvoices')}
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-[26px] font-bold text-text">
              {isNew
                ? t('rechnungen.newInvoice')
                : invoice?.invoiceNumber
                  ? t('rechnungen.invoiceNumbered', { number: invoice.invoiceNumber })
                  : t('rechnungen.invoice')}
            </h1>
            {invoice !== null && (
              <InvoiceStatusBadge paymentState={invoice.paymentState} />
            )}
          </div>
          <p className="mt-0.5 text-sm text-leise">
            {t('rechnungen.forCompany')}{' '}
            <Link
              to={`/companies/${company.id}`}
              className="underline underline-offset-2 hover:text-primaer"
            >
              {company.name}
            </Link>
          </p>
        </div>
      </div>

      {/* DER BERNSTEINFARBENE HINWEISSTREIFEN des Entwurfs — mit einer
          Abweichung im Wortlaut, und zwar einer wesentlichen. Dort steht „Aus
          dem Vertrag der Organisation ERZEUGT". Das wäre hier falsch: Es gibt
          keinen Erzeuger. Entwürfe entstehen ausschliesslich durch eine
          Handlung (R5); die Aufgabe „Rechnung fällig" führt hierher und
          belegt die Werte VOR, mehr nicht. */}
      {draftMode && (
        <NoticeBar kind="attention" className="mb-4">
          {t('rechnungen.draftNotice')}
        </NoticeBar>
      )}

      {draftMode ? (
        <InvoiceDraftForm
          company={company}
          invoice={invoice}
          totpPossible={totpPossible}
          suggestion={suggestion}
          suggestionError={suggestionError}
          onSaved={(saved, wasNew, message) => {
            setInvoice(saved);
            // Beim stillen Vorab-Speichern vor der Festschreib-Vorschau bleibt
            // die Meldung aus: Sie läge sonst über der Fußleiste des gleich
            // öffnenden Dialogs (gemessen bei 375 × 700 px).
            if (message) toast.show(t('rechnungen.draftSaved'));
            if (wasNew) {
              // Dieselbe wahrgenommene Seite, nur die URL wird „echt" — kein
              // Zwischenzustand, der beim Verlassen etwas verlöre.
              navigate(`/invoices/${saved.id}`, { replace: true });
            }
          }}
          onCancel={() => navigate(`/companies/${company.id}`)}
          onDeleted={() => {
            toast.show(t('rechnungen.draftDeleted'));
            navigate(`/companies/${company.id}`);
          }}
          onFinalized={(finalized) => {
            setInvoice(finalized);
            toast.show(t('rechnungen.invoiceFinalized', { number: finalized.invoiceNumber ?? '' }));
          }}
        />
      ) : invoice !== null ? (
        <InvoiceView
          invoice={invoice}
          companyId={company.id}
          totpPossible={totpPossible}
          contactDataDeleted={
            company.name === NAME_AFTER_CONTACT_DATA_DELETION
          }
          onChanged={setInvoice}
          onCancelled={(result) => {
            toast.show(
              t('rechnungen.invoiceCancelled', { number: result.cancellation.invoiceNumber ?? '' }),
            );
            // Der Weg führt auf die STORNORECHNUNG: Sie ist der gerade
            // entstandene, wichtigere Beleg, und ihr Kopfblock zeigt den
            // Verweis zurück auf das Original.
            navigate(`/invoices/${result.cancellation.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
