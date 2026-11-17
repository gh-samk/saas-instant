import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, SearchX, Trash2 } from 'lucide-react';
import {
  DateField,
  InputField,
  FilterChips,
  DangerCard,
  Card,
  Button,
  EmptyState,
  Switch,
  Menu,
  type MenuItem,
  Skeleton,
  StatusPill,
  useToast,
  ROW_LINK_CLASSES,
} from '@saas-instant/ui';
import { ContactPersonDialog } from '../components/ContactPersonDialog';
import { DetailBlock, Field } from '../components/DetailBlock';
import { HelpHint, SelectField, TextArea } from '../components/FormFields';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { hasOwnBillingAddress } from '../utils/recipient';
import { IntakeCard } from '../components/IntakeCard';
import { InstanceCard } from '../components/InstanceCard';
import { ConsentStatusBadge } from '../components/ConsentStatusBadge';
import { CompanyStatusBadge } from '../components/CompanyStatusBadge';
import { CompanyOverview } from '../components/CompanyOverview';
import { CompanyHistory } from '../components/CompanyHistory';
import { InvoicesCard } from '../components/InvoicesCard';
import { ContactDataDeleteDialog } from '../components/ContactDataDeleteDialog';
import { CompanyDeleteDialog } from '../components/CompanyDeleteDialog';
import { StatusChangeDialog } from '../components/StatusChangeDialog';
import { PaymentDetailsCard } from '../components/PaymentDetailsCard';
import { useAuth } from '../context/AuthContext';
import { ApiError, errorText } from '../lib/api-client';
import {
  updateCompany,
  fetchCompany,
  fetchInstance,
  type Source,
  type BuyerType,
  type Company,
  type CompanyChange,
  type PaymentMethod,
  type PaymentInterval,
} from '../lib/api';
import {
  SOURCE_LABEL,
  PAYMENT_INTERVAL_LABEL,
} from '../lib/company-status';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';
import { safeHref } from '../common/http-url';

const BUYER_TYPE_KEY: Record<BuyerType, string> = {
  business: 'organisationen.buyerTypeBusiness',
  authority: 'organisationen.buyerTypeAuthority',
  consumer: 'organisationen.buyerTypeConsumer',
};

const ELECTRONIC_ADDRESS_SCHEMES = ['EM', '0204', '9930', '0088', '0060'] as const;

type Blockname = 'masterData' | 'invoice' | 'einvoice' | 'contacts' | 'contract';

/** Alle Formularwerte als Zeichenketten — so, wie Eingabefelder sie führen. */
interface Draft {
  name: string;
  legalForm: string;
  website: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
  source: string;
  notes: string;
  billingName: string;
  billingStreet: string;
  billingHouseNumber: string;
  billingPostalCode: string;
  billingCity: string;
  billingCountry: string;
  billingEmail: string;
  deputyName: string;
  deputyRole: string;
  deputyEmail: string;
  deputyPhone: string;
  priceTier: string;
  buyerType: string;
  vatId: string;
  buyerReference: string;
  electronicAddress: string;
  electronicAddressScheme: string;
  paymentInterval: string;
  paymentMethod: string;
  instanceStartDate: string;
}

function draftFrom(o: Company): Draft {
  return {
    name: o.name,
    legalForm: o.legalForm ?? '',
    website: o.website ?? '',
    street: o.street ?? '',
    houseNumber: o.houseNumber ?? '',
    postalCode: o.postalCode ?? '',
    city: o.city ?? '',
    country: o.country ?? '',
    source: o.source ?? '',
    notes: o.notes ?? '',
    billingName: o.billingName ?? '',
    billingStreet: o.billingStreet ?? '',
    billingHouseNumber: o.billingHouseNumber ?? '',
    billingPostalCode: o.billingPostalCode ?? '',
    billingCity: o.billingCity ?? '',
    billingCountry: o.billingCountry ?? '',
    billingEmail: o.billingEmail ?? '',
    deputyName: o.deputyName ?? '',
    deputyRole: o.deputyRole ?? '',
    deputyEmail: o.deputyEmail ?? '',
    deputyPhone: o.deputyPhone ?? '',
    priceTier: o.priceTier ?? '',
    buyerType: o.buyerType ?? 'business',
    vatId: o.vatId ?? '',
    buyerReference: o.buyerReference ?? '',
    electronicAddress: o.electronicAddress ?? '',
    electronicAddressScheme: o.electronicAddressScheme ?? 'EM',
    paymentInterval: o.paymentInterval ?? '',
    paymentMethod: o.paymentMethod ?? '',
    instanceStartDate: o.instanceStartDate ?? '',
  };
}

/**
 * Ein leeres Feld bedeutet „leeren", nicht „unverändert lassen".
 *
 * Der Server unterscheidet drei Zustände: nicht mitgeschickt = unangetastet,
 * `null` = leeren, Wert = setzen. Ein Formular kennt nur zwei — deshalb wird
 * jedes Feld seiner Karte mitgeschickt, leere als `null`.
 */
function text(value: string): string | null {
  const cleaned = value.trim();
  return cleaned === '' ? null : cleaned;
}

/** Leere Adresszeilen bleiben null; das Anschriftsfeld hat keine Zwischenform. */
function noBillingAddress(o: Company): boolean {
  return (
    o.billingName === null &&
    o.billingStreet === null &&
    o.billingHouseNumber === null &&
    o.billingPostalCode === null &&
    o.billingCity === null &&
    o.billingCountry === null &&
    o.billingEmail === null
  );
}

/**
 * Detailseite einer Organisation.
 *
 * BEARBEITET WIRD JE KARTE, nicht als Ganzes. Ein Formular mit dreißig
 * Eingaben am Stück ist unbenutzbar; vier nach Sinnzusammenhang gruppierte
 * Blöcke, die einzeln gespeichert werden, sind es nicht. Wer nur die
 * Telefonnummer der Stellvertretung nachträgt, öffnet eine Karte.
 *
 * ZWEI ÄNDERUNGEN LAUFEN NICHT ÜBER DIESE FORMULARE, weil der Server sie in
 * PATCH ausdrücklich zurückweist:
 * - der Status (eigener Dialog, eigener Endpunkt, erzeugt eine Systemnotiz),
 * - die Hauptansprechpartnerin (dito, der Datensatz wird ersetzt),
 */
/**
 * Die sechs Reiter der Detailseite.
 *
 * SIE ERSETZEN EINE LANGE SCROLLSEITE, kein einziger Inhalt entfaellt dabei.
 * Vorher standen Stammdaten, Rechnungsadresse, Kontakte, Vertragsdaten,
 * Zahlungsdaten, Instanz, Rechnungen, Verlauf und der Loeschweg
 * untereinander — neun Karten, die man durchscrollen musste, um die eine zu
 * finden. Jetzt sind es sechs benannte Orte.
 *
 * Der Wert steht in der URL; „ueberblick" ist die Vorgabe und wird deshalb
 * NICHT geschrieben — sonst traegt jeder geteilte Link einen Parameter, der
 * nichts aussagt.
 */
const TABS = [
  { value: 'overview', labelKey: 'organisationen.tabOverview' },
  { value: 'instance', labelKey: 'organisationen.instance' },
  { value: 'invoices', labelKey: 'organisationen.invoices' },
  { value: 'contract', labelKey: 'organisationen.tabContactContract' },
  { value: 'history', labelKey: 'organisationen.history' },
  { value: 'privacy', labelKey: 'organisationen.privacy' },
] as const;

export function CompanyDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const toast = useToast();
  /**
   * Der Ausschnitt der Liste (Status, Suche, Seite) reist an der URL mit.
   * Ohne ihn führte „Zu allen Organisationen" auf die ungefilterte Liste
   * zurück, und jedes Zurückspringen begänne die Arbeit von vorn — genau das,
   * wofür der Filter überhaupt in der URL steht.
   */
  const navigate = useNavigate();
  const [parameter, setParameter] = useSearchParams();

  /**
   * `tab` bleibt beim Rückweg AUSSEN VOR. Er beschreibt, wo man INNERHALB
   * dieser Organisation stand — auf der Liste bedeutet er nichts und würde
   * dort als unverstandener Parameter mitreisen.
   */
  const backToList = (() => {
    const withoutTab = new URLSearchParams(parameter);
    withoutTab.delete('tab');
    return { pathname: '/companies', search: withoutTab.toString() };
  })();

  const [company, setCompany] = useState<Company | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [openBlock, setOpenBlock] = useState<Blockname | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [matchesAddress, setMatchesAddress] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [companyDeleteOpen, setCompanyDeleteOpen] =
    useState(false);
  const [historyState, setHistoryState] = useState(0);
  /**
   * „Instanz anlegen" aus dem Überblick: Der Dialog gehört der Instanzkarte, die
   * es erst nach dem Reiterwechsel gibt. Die Anforderung bleibt deshalb hier
   * stehen, bis die Karte sie gelesen und zurückgemeldet hat — sonst öffnete
   * sich der Dialog bei jedem späteren Zurückkehren auf den Reiter von neuem.
   */
  const [instanceCreateRequested, setInstanceCreateRequested] = useState(false);
  /**
   * Gibt es schon eine Instanz? Davon hängt die Hauptaktion im Kopf ab
   * („Instanz anlegen" oder „Rechnung anlegen"). `loading` zeigt noch keine,
   * statt erst die eine und dann die andere aufblitzen zu lassen; scheitert
   * die Abfrage, bleibt es bei „Rechnung anlegen" — das ist nie falsch.
   */
  const [instanceState, setInstanceState] = useState<
    'loading' | 'yes' | 'no' | 'unknown'
  >('loading');
  /** Aufgeklappt per Link, obwohl die Karte nach der Regel verborgen wäre. */
  const [einvoiceShown, setEinvoiceShown] = useState(false);
  const [intakeShown, setIntakeShown] = useState(false);

  /**
   * Der offene Reiter steht IN DER URL, nicht nur im Zustand.
   *
   * Zwei Gründe, und beide sind praktisch: Eine Dashboard-Aufgabe kann so
   * genau dorthin führen, wo die Handlung stattfindet („Instanz anlegen" →
   * Reiter Instanz), statt an den Seitenanfang. Und wer einen Reiter offen
   * hat, neu lädt oder den Link teilt, landet wieder dort.
   */
  const tab = TABS.find((r) => r.value === parameter.get('tab')) ?? TABS[0];
  const setTab = (value: string) => {
    setParameter(
      (alt) => {
        const updated = new URLSearchParams(alt);
        if (value === TABS[0].value) updated.delete('tab');
        else updated.set('tab', value);
        return updated;
      },
      { replace: true },
    );
  };

  /**
   * Ohne eingerichtete Authenticator-App nimmt der Server nur das Passwort an.
   * Der Nachweis-Dialog blendet den Umschalter dann aus — ein Weg, der ins
   * Leere führt, ist schlimmer als keiner.
   */
  const { state } = useAuth();
  const totpPossible = state?.totpSetUp ?? false;

  const load = useCallback(async () => {
    setLoadError(null);
    setNotFound(false);
    try {
      setCompany(await fetchCompany(id));
    } catch (f) {
      if (f instanceof ApiError && f.status === 404) {
        setNotFound(true);
        return;
      }
      setLoadError(
        errorText(f, t('organisationen.loadCompanyFailed')),
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkInstance = useCallback(async () => {
    try {
      // Ohne Instanz antwortet der Server mit `null` ODER mit leerem Körper.
      setInstanceState((await fetchInstance(id)) == null ? 'no' : 'yes');
    } catch {
      setInstanceState('unknown');
    }
  }, [id]);

  useEffect(() => {
    setInstanceState('loading');
    setEinvoiceShown(false);
    setIntakeShown(false);
    void checkInstance();
  }, [checkInstance]);

  // „+ Instanz" aus der Instanzliste: `?create=instance` öffnet den
  // Anlegen-Dialog im Reiter „Instanz". Der Parameter wird sofort entfernt,
  // damit ein Neuladen oder Zurückspringen den Dialog nicht erneut öffnet.
  const createWanted = parameter.get('create') === 'instance';
  useEffect(() => {
    if (!createWanted || company === null) return;
    setInstanceCreateRequested(true);
    setParameter(
      (alt) => {
        const updated = new URLSearchParams(alt);
        updated.delete('create');
        return updated;
      },
      { replace: true },
    );
  }, [createWanted, company, setParameter]);

  function editStart(block: Blockname, o: Company) {
    setDraft(draftFrom(o));
    setMatchesAddress(noBillingAddress(o));
    setSaveError(null);
    setOpenBlock(block);
  }

  function cancel() {
    setOpenBlock(null);
    setDraft(null);
    setSaveError(null);
  }

  async function save(change: CompanyChange) {
    setSaving(true);
    setSaveError(null);
    try {
      setCompany(await updateCompany(id, change));
      setOpenBlock(null);
      setDraft(null);
      toast.show(t('organisationen.changeSaved'));
    } catch (f) {
      // Der Bearbeitungsmodus bleibt offen: Eingetipptes geht nicht verloren.
      setSaveError(
        errorText(f, t('organisationen.changeSaveFailed')),
      );
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <section aria-labelledby="company-title">
        {/* Die Seite braucht eine Überschrift; der Wortlaut des
            Leerzustands darunter wird bewusst NICHT wiederholt. */}
        <h1 id="company-title" className="sr-only">
          {t('organisationen.company')}
        </h1>
        <Card>
          <EmptyState
            Icon={SearchX}
            title={t('organisationen.notFoundTitle')}
            notice={t('organisationen.notFoundHint')}
            action={
              <Link
                to={backToList}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primaer px-4 py-2 text-sm font-medium text-primaer-text transition-colors hover:bg-primaer-hover"
              >
                {t('organisationen.toAllCompanies')}
              </Link>
            }
          />
        </Card>
      </section>
    );
  }

  if (loadError) {
    return (
      <section aria-labelledby="company-title">
        <h1 id="company-title" className="sr-only">
          {t('organisationen.company')}
        </h1>
        <div className="rounded-xl border border-rahmen bg-flaeche p-6">
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('organisationen.retry')}
          </Button>
        </div>
      </section>
    );
  }

  if (company === null) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const o = company;
  const e = draft;
  const blocked = (block: Blockname) =>
    openBlock !== null && openBlock !== block;
  const setField = (field: keyof Draft) => (value: string) =>
    setDraft((alt) => (alt === null ? alt : { ...alt, [field]: value }));

  const createInvoice = () => navigate(`/companies/${o.id}/invoices/new`);
  const createInstance = () => {
    setInstanceCreateRequested(true);
    setTab('instance');
  };
  // Die Hauptaktion folgt dem Status: Solange nur angefragt wurde, gibt es
  // nichts anzulegen (die Instanz kommt erst mit der Testphase) — der nächste
  // Schritt ist der Statuswechsel. Danach gilt:
  // ohne Instanz „Instanz anlegen", sonst „Rechnung anlegen".
  const statusPrimary = o.status === 'inquiry';
  const primaryAction = statusPrimary
    ? { label: t('organisationen.changeStatus'), run: () => setStatusOpen(true) }
    : instanceState === 'loading'
      ? null
      : instanceState === 'no' && o.status !== 'ended'
        ? { label: t('organisationen.createInstance'), run: createInstance }
        : { label: t('organisationen.createInvoice'), run: createInvoice };
  // Was nicht Hauptaktion ist, steht im Menü: E-Mail nur, wenn es eine
  // Adresse gibt (ein Eintrag, der nichts tun kann, wäre Lärm), und
  // „Rechnung anlegen" auch dann, wenn gerade „Instanz anlegen" vorn steht.
  const moreItems: MenuItem[] = [
    ...(primaryAction?.run !== createInvoice
      ? [{ id: 'invoice', label: t('organisationen.createInvoice'), onSelect: createInvoice }]
      : []),
    ...(o.contactEmail
      ? [
          {
            id: 'email',
            label: t('organisationen.emailTo', { email: o.contactEmail }),
            onSelect: () => {
              window.location.href = `mailto:${o.contactEmail ?? ''}`;
            },
          },
        ]
      : []),
    {
      id: 'edit',
      label: t('organisationen.editMasterData'),
      onSelect: () => {
        setTab('contract');
        editStart('masterData', o);
      },
    },
    ...(statusPrimary
      ? []
      : [
          {
            id: 'status',
            label: t('organisationen.changeStatus'),
            onSelect: () => setStatusOpen(true),
          },
        ]),
  ];

  /** Leeres optionales Feld → „+ … hinzufügen", das den Block öffnet (nicht, solange ein anderer offen ist). */
  const add = (block: Blockname) =>
    openBlock === null ? () => editStart(block, o) : undefined;

  return (
    <section aria-labelledby="company-title">
      <Link
        to={backToList}
        className="mb-2 inline-flex min-h-11 items-center sm:min-h-0 gap-1 text-sm text-primaer underline underline-offset-2 hover:text-primaer-hover"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('organisationen.toAllCompanies')}
      </Link>

      {/* KOPFKARTE UND REITER BLEIBEN OBEN STEHEN. Wer im Reiter „Verlauf"
          weit unten liest, soll ohne Zurückscrollen wechseln können — und
          immer sehen, in welcher Organisation er ist. */}
      <div className="sticky top-[58px] z-20 -mx-4 bg-flaeche-2 px-4 pb-1 pt-1 lg:-mx-6 lg:px-6">
        <Card className="p-[18px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              {/* Der volle Name wird hier nie gekürzt — anders als in der
                  Tabelle. Er ist die Überschrift der Seite, und Platz ist da. */}
              <div className="flex flex-wrap items-center gap-3">
                <h1
                  id="company-title"
                  className="text-2xl font-semibold tracking-tight text-text break-words"
                >
                  {o.name}
                </h1>
                <CompanyStatusBadge status={o.status} />
              </div>
              <p className="mt-1 text-sm text-leise">
                {o.city ? `${o.city} · ` : ''}{t('organisationen.createdOn')}{' '}
                <span className="ziffern-tabellarisch">
                  {formatDate(o.createdAt)}
                </span>
                {o.source ? ` · ${SOURCE_LABEL[o.source]}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* EINE Hauptaktion mit Text, der Rest im Menü — ebenfalls mit
                  Text. Vorher standen hier drei Icons ohne sichtbare
                  Beschriftung; sehende Nutzerinnen mussten raten. Die
                  Hauptaktion folgt dem Status: Anfrage und Demo
                  „Status ändern", danach ohne Instanz „Instanz anlegen",
                  sonst „Rechnung anlegen". Alle FÜHREN nur — gelöst wird
                  erst im Dialog bzw. im Entwurf. */}
              {primaryAction && (
                <Button onClick={primaryAction.run} className="w-full sm:w-auto">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {primaryAction.label}
                </Button>
              )}
              <Menu
                label={t('organisationen.moreActions')}
                hideChevron
                items={moreItems}
                className="w-full sm:w-auto"
              />
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <FilterChips
              label={t('organisationen.companyAreaLabel')}
              active={tab.value}
              onSelect={setTab}
              chips={TABS.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
            />
          </div>
        </Card>
      </div>

      {/* ============================================ Reiter „Überblick" */}
      {tab.value === 'overview' && (
        <ErrorBoundary area={t('organisationen.sectionOverview')}>
          <CompanyOverview
            company={o}
            onContactEdit={() => {
              setTab('contract');
              editStart('contacts', o);
            }}
            onDeputy={() => {
              setTab('contract');
              editStart('contacts', o);
            }}
            onContract={() => {
              setTab('contract');
              editStart('contract', o);
              // Der Reiter ist über 2000 px lang: Ohne Scrollen öffnete sich
              // das Formular außerhalb des Bildschirms. Erst nach dem
              // Rendern, sonst gibt es den Anker noch nicht.
              window.setTimeout(() => {
                document
                  .getElementById('vertragsdaten')
                  ?.scrollIntoView?.({ block: 'start' });
              }, 0);
            }}
            onInstance={() => {
              setInstanceCreateRequested(true);
              setTab('instance');
            }}
            onInvoice={() => navigate(`/companies/${o.id}/invoices/new`)}
          />
        </ErrorBoundary>
      )}

      {/* ============================================== Reiter „Instanz" */}
      {tab.value === 'instance' && (
        <>
        {/* -------------------------------------------------------- Instanz */}
        {/* Die Karte stand seit Etappe 2 an dieser Stelle; jetzt wechselt nur
            ihr Inhalt. Sie hält ihren Zustand selbst aktuell — das Anlegen
            dauert Minuten, und der Dialog dafür schließt sofort. */}
        <ErrorBoundary area={t('organisationen.sectionInstance')}>
          <InstanceCard
            companyId={o.id}
            companyName={o.name}
            contactEmail={o.contactEmail}
            totpPossible={totpPossible}
            onHistoryChanged={() => {
              setHistoryState((n) => n + 1);
              void checkInstance();
            }}
            createRequested={instanceCreateRequested}
            onCreateRequestHandled={() => setInstanceCreateRequested(false)}
          />
        </ErrorBoundary>
        </>
      )}

      {/* =========================================== Reiter „Rechnungen" */}
      {tab.value === 'invoices' && (
        <>
        {/* ----------------------------------------------------- Rechnungen */}
        {/* Die Karte stand seit Etappe 2 als Platzhalter an dieser Stelle; jetzt
            wechselt nur ihr Inhalt. Sie lädt ihre Liste selbst — es gibt bewusst
            keine systemweite Rechnungsübersicht, weil der Server dafür keine
            Route hat und das Dashboard die übergreifende Frage („was ist
            überfällig") bereits arbeitsorientiert beantwortet. */}
        <ErrorBoundary area={t('organisationen.sectionInvoices')}>
          <InvoicesCard companyId={o.id} />
        </ErrorBoundary>
        </>
      )}

      {/* ==================================== Reiter „Kontakt & Vertrag" */}
      {tab.value === 'contract' && (
        <>
        {/* ------------------------------------------------------ Stammdaten */}
        <DetailBlock
          title={t('organisationen.masterData')}
          edit={openBlock === 'masterData'}
          blocked={blocked('masterData')}
          loading={saving}
          error={saveError}
          onEditStart={() => editStart('masterData', o)}
          onCancel={cancel}
          onSave={() => {
            if (!e) return;
            if (e.name.trim() === '') {
              setSaveError(t('organisationen.nameRequired'));
              return;
            }
            void save({
              name: e.name.trim(),
              legalForm: text(e.legalForm),
              website: text(e.website),
              street: text(e.street),
              houseNumber: text(e.houseNumber),
              postalCode: text(e.postalCode),
              city: text(e.city),
              country: text(e.country),
              source: e.source === '' ? null : (e.source as Source),
              notes: text(e.notes),
            });
          }}
          form={
            e && (
              <>
                <InputField
                  label={t('organisationen.companyName')}
                  name="name"
                  required
                  value={e.name}
                  onChange={(ev) => setField('name')(ev.target.value)}
                />
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <InputField
                    label={t('organisationen.legalForm')}
                    name="legalForm"
                    value={e.legalForm}
                    onChange={(ev) => setField('legalForm')(ev.target.value)}
                  />
                  <InputField
                    label={t('organisationen.website')}
                    name="website"
                    type="url"
                    value={e.website}
                    onChange={(ev) => setField('website')(ev.target.value)}
                  />
                </div>
                {/* Straße/Hausnummer und PLZ/Ort bleiben auch bei 375 px
                    dreispaltig: Hausnummer und PLZ sind kurz genug. */}
                <div className="grid grid-cols-3 gap-x-3">
                  <div className="col-span-2">
                    <InputField
                      label={t('organisationen.street')}
                      name="street"
                      value={e.street}
                      onChange={(ev) => setField('street')(ev.target.value)}
                    />
                  </div>
                  <InputField
                    label={t('organisationen.houseNumberShort')}
                    name="houseNumber"
                    value={e.houseNumber}
                    onChange={(ev) => setField('houseNumber')(ev.target.value)}
                  />
                </div>
                <div className="grid grid-cols-3 gap-x-3">
                  <InputField
                    label={t('organisationen.postalCode')}
                    name="postalCode"
                    inputMode="numeric"
                    value={e.postalCode}
                    onChange={(ev) => setField('postalCode')(ev.target.value)}
                  />
                  <div className="col-span-2">
                    <InputField
                      label={t('organisationen.city')}
                      name="city"
                      value={e.city}
                      onChange={(ev) => setField('city')(ev.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <InputField
                    label={t('organisationen.country')}
                    name="country"
                    value={e.country}
                    onChange={(ev) => setField('country')(ev.target.value)}
                  />
                  <SelectField
                    label={t('organisationen.source')}
                    id="source"
                    value={e.source}
                    onChange={setField('source')}
                  >
                    <option value="">{t('organisationen.noInfo')}</option>
                    {(
                      ['form', 'phone', 'referral', 'event'] as const
                    ).map((h) => (
                      <option key={h} value={h}>
                        {SOURCE_LABEL[h]}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <TextArea
                  label={t('organisationen.otherNotes')}
                  id="notes"
                  value={e.notes}
                  onChange={setField('notes')}
                  helperText={t('organisationen.otherNotesHint')}
                />
              </>
            )
          }
        >
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('organisationen.legalForm')} onAdd={add('masterData')}>
              {o.legalForm}
            </Field>
            <Field label={t('organisationen.website')} onAdd={add('masterData')}>
              {o.website && safeHref(o.website) === null && o.website}
              {safeHref(o.website) !== null && (
                <a
                  href={safeHref(o.website) ?? undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primaer underline underline-offset-2 hover:text-primaer-hover"
                >
                  {o.website}
                </a>
              )}
            </Field>
            <Field label={t('organisationen.address')} wide onAdd={add('masterData')}>
              {o.street || o.postalCode || o.city ? (
                <>
                  {[o.street, o.houseNumber].filter(Boolean).join(' ')}
                  {(o.street || o.houseNumber) && (o.postalCode || o.city) ? <br /> : null}
                  {[o.postalCode, o.city].filter(Boolean).join(' ')}
                  {o.country ? (
                    <>
                      <br />
                      {o.country}
                    </>
                  ) : null}
                </>
              ) : null}
            </Field>
            <Field label={t('organisationen.otherNotes')} wide onAdd={add('masterData')}>
              {o.notes ? (
                <span className="whitespace-pre-line">{o.notes}</span>
              ) : null}
            </Field>
          </dl>
        </DetailBlock>

        {/* -------------------------------------------------- Aufnahmeformular */}
        {/* NUR IN DER AUFNAHMEPHASE UND NACH DEN STAMMDATEN. Das Formular
            sammelt Anschrift, Ansprechperson, Zahlung und Mandat und wird
            genau einmal gebraucht: Der Link geht beim Wechsel auf „Testphase"
            hinaus. Davor gibt es keinen Anlass, danach steht die
            Karte nicht mehr im Weg — wer ihren Nachweis oder den Link später
            braucht, holt sie über den dezenten Link darunter zurück (ein
            Wegblenden ohne Rückweg wäre ein verlorener Nachweis des Versands). */}
        {o.status === 'trial' || intakeShown ? (
          <ErrorBoundary area={t('organisationen.sectionIntakeForm')}>
            <IntakeCard companyId={o.id} totpPossible={totpPossible} />
          </ErrorBoundary>
        ) : o.status !== 'inquiry' ? (
          <p className="mt-4">
            <button
              type="button"
              onClick={() => setIntakeShown(true)}
              className="inline-flex min-h-11 items-center text-sm text-leise underline underline-offset-2 hover:text-text sm:min-h-0"
            >
              {t('organisationen.intakeShow')}
            </button>
          </p>
        ) : null}

        {/* ------------------------------------------------ Rechnungsadresse */}
        <DetailBlock
          title={t('organisationen.billingAddress')}
          edit={openBlock === 'invoice'}
          blocked={blocked('invoice')}
          loading={saving}
          error={saveError}
          onEditStart={() => editStart('invoice', o)}
          onCancel={cancel}
          onSave={() => {
            if (!e) return;
            void save(
              matchesAddress
                ? {
                    billingName: null,
                    billingStreet: null,
                    billingHouseNumber: null,
                    billingPostalCode: null,
                    billingCity: null,
                    billingCountry: null,
                    billingEmail: null,
                  }
                : {
                    billingName: text(e.billingName),
                    billingStreet: text(e.billingStreet),
                    billingHouseNumber: text(e.billingHouseNumber),
                    billingPostalCode: text(e.billingPostalCode),
                    billingCity: text(e.billingCity),
                    billingCountry: text(e.billingCountry),
                    billingEmail: text(e.billingEmail),
                  },
            );
          }}
          form={
            e && (
              <>
                <div className="mb-4 flex items-center gap-3">
                  <Switch
                    on={matchesAddress}
                    onToggle={setMatchesAddress}
                    label={t('organisationen.billingMatchesAddress')}
                  />
                  <span className="text-sm text-text">
                    {t('organisationen.billingMatchesAddress')}
                  </span>
                </div>
                {!matchesAddress && (
                  <>
                    {/* Bewusst NICHT aus der Anschrift vorausgefüllt: Eine
                        abweichende Rechnungsadresse trägt in aller Regel auch
                        einen anderen Namen (Buchhaltung statt Geschäftsstelle),
                        und ein „ausgefüllt aussehendes" Feld bliebe leicht
                        unbemerkt falsch. */}
                    <InputField
                      label={t('organisationen.billingRecipientName')}
                      name="billingName"
                      value={e.billingName}
                      onChange={(ev) => setField('billingName')(ev.target.value)}
                    />
                    <div className="grid grid-cols-3 gap-x-3">
                      <div className="col-span-2">
                        <InputField
                          label={t('organisationen.street')}
                          name="billingStreet"
                          value={e.billingStreet}
                          onChange={(ev) =>
                            setField('billingStreet')(ev.target.value)
                          }
                        />
                      </div>
                      <InputField
                        label={t('organisationen.houseNumberShort')}
                        name="billingHouseNumber"
                        value={e.billingHouseNumber}
                        onChange={(ev) =>
                          setField('billingHouseNumber')(ev.target.value)
                        }
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-x-3">
                      <InputField
                        label={t('organisationen.postalCode')}
                        name="billingPostalCode"
                        inputMode="numeric"
                        value={e.billingPostalCode}
                        onChange={(ev) => setField('billingPostalCode')(ev.target.value)}
                      />
                      <div className="col-span-2">
                        <InputField
                          label={t('organisationen.city')}
                          name="billingCity"
                          value={e.billingCity}
                          onChange={(ev) =>
                            setField('billingCity')(ev.target.value)
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                      <InputField
                        label={t('organisationen.country')}
                        name="billingCountry"
                        value={e.billingCountry}
                        onChange={(ev) =>
                          setField('billingCountry')(ev.target.value)
                        }
                      />
                      <InputField
                        label={t('organisationen.invoiceEmail')}
                        name="billingEmail"
                        type="email"
                        value={e.billingEmail}
                        onChange={(ev) =>
                          setField('billingEmail')(ev.target.value)
                        }
                      />
                    </div>
                  </>
                )}
              </>
            )
          }
        >
          {noBillingAddress(o) ? (
            <p className="text-sm text-leise">
              {t('organisationen.matchesMasterData')}
            </p>
          ) : (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Name und Anschrift fallen einzeln auf die Stammdaten zurück
                  (wie `utils/recipient.ts`); die E-Mail steht für sich. */}
              <Field label={t('organisationen.name')}>
                {o.billingName?.trim() ? (
                  o.billingName
                ) : (
                  <span className="text-leise">
                    {t('organisationen.likeMasterData')}
                  </span>
                )}
              </Field>
              <Field label={t('organisationen.invoiceEmail')} onAdd={add('invoice')}>
                {o.billingEmail}
              </Field>
              <Field label={t('organisationen.address')} wide>
                {hasOwnBillingAddress(o) ? (
                  <>
                    {[o.billingStreet, o.billingHouseNumber]
                      .filter(Boolean)
                      .join(' ')}
                    {(o.billingStreet || o.billingHouseNumber) &&
                    (o.billingPostalCode || o.billingCity) ? (
                      <br />
                    ) : null}
                    {[o.billingPostalCode, o.billingCity].filter(Boolean).join(' ')}
                    {o.billingCountry ? (
                      <>
                        <br />
                        {o.billingCountry}
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="text-leise">
                    {t('organisationen.likeMasterData')}
                  </span>
                )}
              </Field>
            </dl>
          )}
        </DetailBlock>

        {/* ----------------------------------------------------- E-Rechnung */}
        {/* NUR BEI BEHÖRDEN ODER GESETZTER LEITWEG-ID. Für alle anderen ist die
            Karte Rauschen: Empfängerart „Unternehmen" und lauter leere
            Felder. Während sie bearbeitet wird, bleibt sie in jedem Fall
            stehen, sonst verschwände das Formular unter den Händen (etwa
            beim Wechsel der Empfängerart). Wer sie sonst braucht, kommt über
            den Link darunter hin — und mit ihr auf den Anker `#e-rechnung`. */}
        {o.buyerType === 'authority' ||
        o.buyerReference !== null ||
        einvoiceShown ||
        openBlock === 'einvoice' ? (
          <DetailBlock
            title={t('organisationen.einvoice')}
            id="e-rechnung"
            edit={openBlock === 'einvoice'}
            blocked={blocked('einvoice')}
            loading={saving}
            error={saveError}
            onEditStart={() => editStart('einvoice', o)}
            onCancel={cancel}
            onSave={() => {
              if (!e) return;
              if (e.buyerType === 'authority' && text(e.buyerReference) === null) {
                setSaveError(t('organisationen.leitwegRequired'));
                return;
              }
              const address = text(e.electronicAddress);
              void save({
                buyerType: e.buyerType as BuyerType,
                vatId: text(e.vatId)?.toUpperCase().replace(/\s+/g, '') ?? null,
                buyerReference: e.buyerType === 'consumer' ? null : text(e.buyerReference),
                electronicAddress: address,
                electronicAddressScheme: address ? e.electronicAddressScheme : null,
              });
            }}
            form={
              e && (
                <>
                  <SelectField
                    label={t('organisationen.buyerType')}
                    id="buyerType"
                    value={e.buyerType}
                    onChange={setField('buyerType')}
                    helperText={t('organisationen.buyerTypeHint')}
                  >
                    <option value="business">{t('organisationen.buyerTypeBusiness')}</option>
                    <option value="authority">{t('organisationen.buyerTypeAuthority')}</option>
                    <option value="consumer">{t('organisationen.buyerTypeConsumer')}</option>
                  </SelectField>
                  {e.buyerType !== 'consumer' && (
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                      <InputField
                        label={t('organisationen.vatId')}
                        name="vatId"
                        value={e.vatId}
                        onChange={(ev) => setField('vatId')(ev.target.value)}
                        helperText={t('organisationen.vatIdHint')}
                      />
                      <div className="relative">
                        <InputField
                          label={
                            e.buyerType === 'authority'
                              ? t('organisationen.leitwegIdRequired')
                              : t('organisationen.buyerReference')
                          }
                          name="buyerReference"
                          required={e.buyerType === 'authority'}
                          value={e.buyerReference}
                          onChange={(ev) => setField('buyerReference')(ev.target.value)}
                          helperText={
                            e.buyerType === 'authority'
                              ? t('organisationen.leitwegIdAuthorityHint')
                              : t('organisationen.buyerReferenceHint')
                          }
                        />
                        {/* Das Icon sitzt in der Beschriftungszeile des Feldes. */}
                        <span className="absolute right-6 top-0">
                          <HelpHint text={t('organisationen.leitwegHelp')} />
                        </span>
                      </div>
                    </div>
                  )}
                  {e.buyerType !== 'consumer' && (
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                      <InputField
                        label={t('organisationen.electronicAddress')}
                        name="electronicAddress"
                        value={e.electronicAddress}
                        onChange={(ev) => setField('electronicAddress')(ev.target.value)}
                        helperText={t('organisationen.electronicAddressHint')}
                      />
                      <SelectField
                        label={t('organisationen.electronicAddressScheme')}
                        id="electronicAddressScheme"
                        value={e.electronicAddressScheme}
                        onChange={setField('electronicAddressScheme')}
                      >
                        {ELECTRONIC_ADDRESS_SCHEMES.map((scheme) => (
                          <option key={scheme} value={scheme}>
                            {t(`organisationen.scheme_${scheme}`)}
                          </option>
                        ))}
                      </SelectField>
                    </div>
                  )}
                </>
              )
            }
          >
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('organisationen.buyerType')}>
                {t(BUYER_TYPE_KEY[o.buyerType ?? 'business'])}
              </Field>
              <Field label={t('organisationen.vatId')} onAdd={add('einvoice')}>
                {o.vatId}
              </Field>
              <Field label={t('organisationen.buyerReference')} onAdd={add('einvoice')}>
                {o.buyerReference}
              </Field>
              <Field label={t('organisationen.electronicAddress')} onAdd={add('einvoice')}>
                {o.electronicAddress
                  ? `${o.electronicAddress}${
                      o.electronicAddressScheme ? ` (${o.electronicAddressScheme})` : ''
                    }`
                  : null}
              </Field>
            </dl>
            {o.buyerType === 'authority' && !o.buyerReference && (
              <p className="mt-3 text-sm text-gefahr" role="status">
                {t('organisationen.leitwegMissing')}
              </p>
            )}
          </DetailBlock>
        ) : (
          <p className="mt-4">
            <button
              type="button"
              onClick={() => {
                setEinvoiceShown(true);
                editStart('einvoice', o);
              }}
              disabled={openBlock !== null}
              className="inline-flex min-h-11 items-center text-sm text-leise underline underline-offset-2 hover:text-text disabled:no-underline disabled:opacity-60 sm:min-h-0"
            >
              {t('organisationen.einvoiceSetup')}
            </button>
          </p>
        )}

        {/* ---------------------------------------------------------- Kontakte */}
        <DetailBlock
          title={t('organisationen.contacts')}
          edit={openBlock === 'contacts'}
          blocked={blocked('contacts')}
          loading={saving}
          error={saveError}
          onEditStart={() => editStart('contacts', o)}
          onCancel={cancel}
          onSave={() => {
            if (!e) return;
            void save({
              deputyName: text(e.deputyName),
              deputyRole: text(e.deputyRole),
              deputyEmail: text(e.deputyEmail),
              deputyPhone: text(e.deputyPhone),
            });
          }}
          form={
            e && (
              <>
                <p className="mb-4 text-sm text-leise">
                  {t('organisationen.mainContactHint')}
                </p>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-leise">
                  {t('organisationen.deputy')}
                </h3>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <InputField
                    label={t('organisationen.name')}
                    name="deputyName"
                    value={e.deputyName}
                    onChange={(ev) =>
                      setField('deputyName')(ev.target.value)
                    }
                  />
                  <InputField
                    label={t('organisationen.role')}
                    name="deputyRole"
                    value={e.deputyRole}
                    onChange={(ev) =>
                      setField('deputyRole')(ev.target.value)
                    }
                  />
                  <InputField
                    label={t('organisationen.email')}
                    name="deputyEmail"
                    type="email"
                    value={e.deputyEmail}
                    onChange={(ev) =>
                      setField('deputyEmail')(ev.target.value)
                    }
                  />
                  <InputField
                    label={t('organisationen.phone')}
                    name="deputyPhone"
                    type="tel"
                    value={e.deputyPhone}
                    onChange={(ev) =>
                      setField('deputyPhone')(ev.target.value)
                    }
                  />
                </div>
              </>
            )
          }
        >
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="min-w-0">
              {/* Beide Spaltenköpfe haben dieselbe Mindesthöhe (die des
                  Knopfes), damit Überschriften und die Felder darunter auf
                  einer Linie stehen — auch in der Spalte ohne Knopf. */}
              <div className="mb-3 flex min-h-11 flex-wrap items-center justify-between gap-2 sm:min-h-10">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-leise">
                  {t('organisationen.mainContact')}
                </h3>
                <Button
                  variant="secondary"
                  disabled={openBlock !== null}
                  onClick={() => setContactOpen(true)}
                >
                  {o.contactName ? t('organisationen.switch') : t('organisationen.enter')}
                </Button>
              </div>
              {o.contactName ||
              o.contactEmail ||
              o.contactPhone ||
              o.contactRole ? (
                <dl className="grid grid-cols-1 gap-4">
                  <Field label={t('organisationen.name')}>{o.contactName}</Field>
                  <Field label={t('organisationen.role')}>{o.contactRole}</Field>
                  <Field label={t('organisationen.email')}>
                    {o.contactEmail && (
                      <a
                        href={`mailto:${o.contactEmail}`}
                        className="text-primaer underline underline-offset-2 hover:text-primaer-hover"
                      >
                        {o.contactEmail}
                      </a>
                    )}
                  </Field>
                  <Field label={t('organisationen.phone')}>{o.contactPhone}</Field>
                </dl>
              ) : (
                <p className="text-sm text-leise">{t('organisationen.notStoredYet')}</p>
              )}
            </div>

            <div className="min-w-0">
              <div className="mb-3 flex min-h-11 items-center sm:min-h-10">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-leise">
                  {t('organisationen.deputy')}
                </h3>
              </div>
              {o.deputyName ||
              o.deputyEmail ||
              o.deputyPhone ||
              o.deputyRole ? (
                <dl className="grid grid-cols-1 gap-4">
                  <Field label={t('organisationen.name')}>{o.deputyName}</Field>
                  <Field label={t('organisationen.role')}>{o.deputyRole}</Field>
                  <Field label={t('organisationen.email')}>
                    {o.deputyEmail && (
                      <a
                        href={`mailto:${o.deputyEmail}`}
                        className="text-primaer underline underline-offset-2 hover:text-primaer-hover"
                      >
                        {o.deputyEmail}
                      </a>
                    )}
                  </Field>
                  <Field label={t('organisationen.phone')}>{o.deputyPhone}</Field>
                </dl>
              ) : (
                /* Vier „—"-Zeilen nebeneinander wären Rauschen ohne Information;
                   ein Satz sagt dasselbe knapper. */
                <p className="text-sm text-leise">{t('organisationen.notStoredYet')}</p>
              )}
            </div>
          </div>
        </DetailBlock>

        {/* ----------------------------------------------------- Vertragsdaten */}
        <DetailBlock
          title={t('organisationen.contractData')}
          id="vertragsdaten"
          edit={openBlock === 'contract'}
          blocked={blocked('contract')}
          loading={saving}
          error={saveError}
          onEditStart={() => editStart('contract', o)}
          onCancel={cancel}
          onSave={() => {
            if (!e) return;
            void save({
              priceTier: text(e.priceTier),
              paymentInterval:
                e.paymentInterval === '' ? null : (e.paymentInterval as PaymentInterval),
              paymentMethod:
                e.paymentMethod === '' ? null : (e.paymentMethod as PaymentMethod),
              instanceStartDate: text(e.instanceStartDate),
            });
          }}
          form={
            e && (
              <>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-leise">
                  {t('organisationen.terms')}
                </h3>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <InputField
                    label={t('organisationen.priceTier')}
                    name="priceTier"
                    value={e.priceTier}
                    onChange={(ev) => setField('priceTier')(ev.target.value)}
                    helperText={t('organisationen.priceTierHint')}
                  />
                  {/* Der abweichende Betrag steht jetzt bei den Zahlungsdaten:
                      Er sagt, wie viel tatsächlich abgebucht wird, und gehört
                      damit zum Zahlungsweg, nicht zu den Stammdaten. */}
                </div>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <SelectField
                    label={t('organisationen.paymentInterval')}
                    id="paymentInterval"
                    value={e.paymentInterval}
                    onChange={(value) => {
                      // MONATLICH ZIEHT DIE LASTSCHRIFT NACH. Das Formular
                      // stellt die passende Art gleich mit ein, statt die
                      // Person erst speichern und dann eine Fehlermeldung
                      // lesen zu lassen. Durchgesetzt wird die Regel
                      // trotzdem serverseitig — hier ist sie Komfort.
                      setField('paymentInterval')(value);
                      if (value === 'monthly') {
                        setField('paymentMethod')('direct_debit');
                      }
                    }}
                  >
                    <option value="">{t('organisationen.noInfo')}</option>
                    <option value="yearly">{t('organisationen.yearly')}</option>
                    <option value="half_yearly">{t('organisationen.halfYearly')}</option>
                    <option value="monthly">{t('organisationen.monthly')}</option>
                  </SelectField>
                  <SelectField
                    label={t('organisationen.paymentMethod')}
                    id="paymentMethod"
                    value={e.paymentMethod}
                    onChange={setField('paymentMethod')}
                    helperText={
                      e.paymentInterval === 'monthly'
                        ? t('organisationen.monthlyDirectDebitOnly')
                        : t('organisationen.bothPossible')
                    }
                  >
                    <option value="">{t('organisationen.noInfo')}</option>
                    <option value="direct_debit">{t('organisationen.directDebit')}</option>
                    {/* BEI MONATLICH GAR NICHT ERST ANBIETEN. Eine Auswahl,
                        die der Server abweist, ist keine Auswahl. */}
                    {e.paymentInterval !== 'monthly' && (
                      <option value="bank_transfer">{t('organisationen.bankTransfer')}</option>
                    )}
                  </SelectField>
                </div>

                <h3 className="mb-3 mt-2 text-sm font-semibold uppercase tracking-wide text-leise">
                  {t('organisationen.dates')}
                </h3>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  <DateField
                    label={t('organisationen.instanceStart')}
                    name="instanceStartDate"
                    value={e.instanceStartDate}
                    onChange={setField('instanceStartDate')}
                  />
                </div>
              </>
            )
          }
        >
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-leise">
            {t('organisationen.terms')}
          </h3>
          <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('organisationen.priceTier')} onAdd={add('contract')}>
              {o.priceTier}
            </Field>
            <Field label={t('organisationen.paymentInterval')} onAdd={add('contract')}>
              {o.paymentInterval ? PAYMENT_INTERVAL_LABEL[o.paymentInterval] : null}
            </Field>
          </dl>

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-leise">
            {t('organisationen.dates')}
          </h3>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('organisationen.instanceStart')} onAdd={add('contract')}>
              {o.instanceStartDate && (
                <span className="ziffern-tabellarisch">
                  {formatDate(o.instanceStartDate)}
                </span>
              )}
            </Field>
          </dl>
        </DetailBlock>

        {/* JEDE SELBSTLADENDE KARTE BEKOMMT IHRE EIGENE FEHLERGRENZE.
            Diese vier holen ihre Daten unabhängig voneinander und rendern, was
            zurückkommt. Ein einziger Lesefehler in einer davon hat am
            2026-08-31 die ganze Seite weiß gemacht — samt dem Weg zur
            Rechnungsverwaltung, der nur hier beginnt. Ab jetzt fällt höchstens
            die betroffene Karte aus, und der Rest bleibt bedienbar. */}
        <ErrorBoundary area={t('organisationen.sectionPaymentDetails')}>
          <PaymentDetailsCard
            companyId={o.id}
            stored={o.paymentDetailsStored}
            totpPossible={totpPossible}
            onChanged={() => void load()}
          />
        </ErrorBoundary>
        </>
      )}

      {/* ============================================== Reiter „Verlauf" */}
      {tab.value === 'history' && (
        <>
        <ErrorBoundary area={t('organisationen.sectionHistory')}>
          <CompanyHistory
            companyId={o.id}
            update={historyState}
          />
        </ErrorBoundary>
        </>
      )}

      {/* ========================================== Reiter „Datenschutz" */}
      {tab.value === 'privacy' && (
        <div className="mt-4">
          {/* ZWEI ZEILEN VOR DEM LÖSCHWEG: Wer über den Personenbezug
              entscheidet, soll vorher sehen, worauf er sich stützt — ob
              eingewilligt wurde und ob eine Sperre vorliegt. Beides steht
              sonst nur im Rundmail-Bereich, also weit weg von der Handlung. */}
          <Card className="mb-4 p-[18px]">
            <h2 className="mb-3 text-lg font-semibold text-text">
              {t('organisationen.consentAndBlock')}
            </h2>
            <div className="flex flex-wrap items-center gap-3 border-b border-rahmen-leise pb-3">
              {o.newsletterConsentStatus ? (
                <ConsentStatusBadge
                  status={o.newsletterConsentStatus}
                />
              ) : (
                <StatusPill kind="neutral">{t('organisationen.noConsent')}</StatusPill>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-leise">
                {o.contactEmail ?? t('organisationen.noAddressStored')}
              </span>
              {o.contactEmail && (
                <Link
                  to={`/consents?email=${encodeURIComponent(o.contactEmail)}`}
                  className={ROW_LINK_CLASSES}
                >
                  {t('organisationen.evidence')}
                </Link>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-3">
              {/* DIE SPERRE STEHT NICHT AN DER ORGANISATION, sondern an der
                  ADRESSE — wer widerspricht, muss bei uns gar nicht
                  eingetragen sein. Deshalb steht hier keine Behauptung,
                  sondern der Weg zur Auskunft. Eine Pille „Keine Sperre" wäre
                  eine Aussage, für die diese Seite die Daten nicht hat. */}
              <span className="min-w-0 flex-1 text-sm text-leise">
                {t('organisationen.blocklistHint')}
              </span>
              <Link to="/broadcast/blocklist" className={ROW_LINK_CLASSES}>
                {t('organisationen.blocklist')}
              </Link>
            </div>
          </Card>

          {/* Die Sprungmarke ist das Ziel der Dashboard-Aufgabe „Löschung
              prüfen": Der Server kann in seiner Handlung nur eine Seite
              benennen, nicht den Abschnitt darin. Der unumkehrbare Dialog
              öffnet sich trotzdem erst auf einen bewussten Klick — ein Link
              darf so etwas nicht auslösen. */}
          <div id="contact-data-delete">
            <DangerCard
              title={t('organisationen.deleteContactData')}
              action={
                /* AUSGESCHRIEBEN, seit es zwei Löschknöpfe auf dieser Seite
                   gibt. „Löschen …" allein steht in der Vorlesestimme ohne
                   den Kartentitel da, und die beiden Wege nehmen sehr
                   Verschiedenes mit. */
                <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('organisationen.deleteContactDataEllipsis')}
                </Button>
              }
            >
              {t('organisationen.deleteContactDataHint')}
            </DangerCard>
          </div>

          {/* DIE ZWEITE, WEITERGEHENDE KARTE. Sie steht bewusst darunter und
              nicht anstelle der ersten: Die beiden Wege sind für
              verschiedene Fälle da, und wer sie verwechselt, verliert
              entweder zu viel oder zu wenig.

              Die Karte wird IMMER gezeigt, auch wenn eine Instanz oder eine
              Rechnung existiert. Diese Seite weiß das nicht sicher — die
              Instanz-Karte lädt ihre Daten selbst, und beides kann sich
              zwischen Laden und Klick ändern. Ein Knopf, der nach der
              Vorstellung dieser Seite gesperrt wäre, wäre entweder falsch
              gesperrt oder falsch offen. Der Server prüft in derselben
              Transaktion, in der er löscht, und nennt beim Abbruch alle
              Hindernisse. */}
          <DangerCard
            title={t('organisationen.deleteCompany')}
            action={
              <Button
                variant="danger"
                onClick={() => setCompanyDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('organisationen.deleteCompanyEllipsis')}
              </Button>
            }
          >
            {t('organisationen.deleteCompanyHint')}
          </DangerCard>
        </div>
      )}


      <StatusChangeDialog
        open={statusOpen}
        companyId={o.id}
        currentStatus={o.status}
        onClose={() => setStatusOpen(false)}
        onChanged={(hint, send) => {
          setStatusOpen(false);
          // EIN Hinweis, nicht zwei übereinander: Ging beim Wechsel der
          // Aufnahmelink hinaus, ist DAS die Nachricht — sie sagt den
          // Statuswechsel mit. Dauerhaft steht der Versand in der
          // Aufnahmekarte; dieser Hinweis ist nur der Augenblick.
          const message =
            hint ??
            (send === null
              ? t('organisationen.statusChanged')
              : send.sent
                ? t('organisationen.statusChangedLinkSent', { email: send.email })
                : send.reason === 'no_address'
                  ? t('organisationen.statusChangedNoEmail')
                  : t('organisationen.statusChangedLinkFailed'));
          toast.show(
            message,
            hint !== null || (send !== null && !send.sent)
              ? 'error'
              : 'success',
          );
          void load();
          setHistoryState((n) => n + 1);
        }}
      />

      <ContactDataDeleteDialog
        open={deleteOpen}
        company={o}
        totpPossible={totpPossible}
        onClose={() => setDeleteOpen(false)}
        onDeleted={(result) => {
          setDeleteOpen(false);
          // Die Zahlen kommen vom Server — die Oberfläche behauptet nicht,
          // etwas geräumt zu haben, was gar nicht da war.
          toast.show(
            t('organisationen.contactDataDeleted', {
              fields: result.cleanedUpFields.length,
              notes: result.deletedNotes,
            }),
          );
          void load();
          setHistoryState((n) => n + 1);
        }}
      />

      <CompanyDeleteDialog
        open={companyDeleteOpen}
        company={o}
        totpPossible={totpPossible}
        onClose={() => setCompanyDeleteOpen(false)}
        onDeleted={(result) => {
          setCompanyDeleteOpen(false);
          // ZUERST WEGNAVIGIEREN, dann melden: Die Seite, auf der wir stehen,
          // gibt es nicht mehr. Ein `laden()` wie bei den anderen Dialogen
          // liefe hier in ein 404 und zeigte „Organisation nicht gefunden"
          // als Fehler — obwohl gerade alles geklappt hat.
          navigate('/companies');
          toast.show(
            result.detachedBlockEntries > 0
              ? t('organisationen.companyDeletedWithBlocklist', {
                  name: result.name,
                  notes: result.deletedNotes,
                  rows: result.deletedSendRows,
                  count: result.detachedBlockEntries,
                })
              : t('organisationen.companyDeleted', {
                  name: result.name,
                  notes: result.deletedNotes,
                  rows: result.deletedSendRows,
                }),
          );
        }}
      />

      <ContactPersonDialog
        open={contactOpen}
        company={o}
        onClose={() => setContactOpen(false)}
        onChanged={(updated) => {
          setContactOpen(false);
          setCompany(updated);
          toast.show(t('organisationen.contactSaved'));
          setHistoryState((n) => n + 1);
        }}
      />
    </section>
  );
}
