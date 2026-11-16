import { useEffect, useRef, useState } from 'react';
import { today } from '@saas-instant/shared';
import { ChevronDown, Info, PlusCircle, Trash2 } from 'lucide-react';
import {
  DateField,
  Dialog,
  InputField,
  Card,
  Button,
  useToast,
} from '@saas-instant/ui';
import { HelpHint, SelectField, TextArea } from './FormFields';
import { InvoiceFinalizeDialog } from './InvoiceFinalizeDialog';
import {
  InvoicePriceSuggestion,
  type AdoptionLines,
} from './InvoicePriceSuggestion';
import { errorText } from '../lib/api-client';
import { issueLine, validationIssues, type ValidationIssue } from '../lib/validation-errors';
import { TEXT_BUTTON_ACTION } from '../lib/styles';
import {
  updateInvoiceDraft,
  createInvoiceDraft,
  deleteInvoiceDraft,
  LINES_MAX_COUNT,
  TAX_RATE_DEFAULT,
  type Company,
  type PriceSuggestion,
  type Invoice,
  type InvoiceLineInput,
} from '../lib/api';
import { centAsFieldValue, centFromInput, formatAmountCent } from '../utils/amount';
import { decimalFieldValue } from '../utils/decimal';
import { servicePeriodSuggestion } from '../utils/service-period';
import { linesAmounts, sums } from '../utils/invoice-amount';
import { t, useT } from '../i18n';

/** Ein Posten, wie das Formular ihn führt: alles als Text. */
interface LinesDraft {
  /** Stabiler React-Schlüssel. Der Index taugt nicht: Zeilen werden gelöscht. */
  key: string;
  label: string;
  description: string;
  quantity: string;
  /** Leistungszeitraum JE POSTEN. Beide oder keiner — der Server prüft es. */
  periodFrom: string;
  periodUntil: string;
  unitPriceNet: string;
  taxRate: string;
  unit: string;
  /** Preisstufe aus dem Vorschlag; leer = kein Stufenbezug. */
  priceTierKey: string;
}

let keyCounter = 0;
function newKey(): string {
  keyCounter += 1;
  return `posten-${keyCounter}`;
}

function emptyLines(): LinesDraft {
  return {
    key: newKey(),
    label: '',
    description: '',
    quantity: '1',
    periodFrom: '',
    periodUntil: '',
    unitPriceNet: '',
    // `Preisvorschlag` liefert keinen Steuersatz — die Vorgabe stammt aus
    // `PREIS_VORGABEN.steuersatz` und bleibt frei editierbar.
    taxRate: String(TAX_RATE_DEFAULT),
    unit: 'C62',
    priceTierKey: '',
  };
}

function linesFrom(invoice: Invoice): LinesDraft[] {
  return invoice.lines.map((p) => ({
    key: newKey(),
    label: p.label,
    // Bis zum Redesign lieferte die Antwort weder `beschreibung` noch
    // `einheit`; beide gingen beim Nachbearbeiten still verloren. Seit E4
    // stehen sie in `RechnungspostenAntwort` und werden hier gelesen.
    description: p.description ?? '',
    // `"1.000"` kommt aus `Decimal(10,3)` und heißt EINS. Im Zahlenfeld steht
    // deshalb `"1"` — derselbe Wert, ohne die Nullen der Spaltendefinition.
    quantity: decimalFieldValue(p.quantity),
    periodFrom: p.periodFrom ?? '',
    periodUntil: p.periodUntil ?? '',
    unitPriceNet: p.unitPriceNet,
    taxRate: decimalFieldValue(p.taxRate),
    unit: normalizeUnit(p.unit),
    priceTierKey: p.priceTierKey ?? '',
  }));
}

/**
 * Die wählbaren Einheiten (UN/ECE Rec. 20, höchstens drei Zeichen — so viel
 * nimmt das Feld `unit` des Servers und so steht es als `unitCode` im XML).
 */
const UNITS: { value: string; label: string }[] = [
  { value: 'C62', label: t('components.invoiceDraftForm.label') },
  { value: 'MON', label: t('components.invoiceDraftForm.label2') },
  { value: 'ANN', label: t('components.invoiceDraftForm.label3') },
  { value: 'LS', label: t('components.invoiceDraftForm.unitLumpSum') },
];

/**
 * Ältere Entwürfe können eine frei getippte Einheit tragen („Stück", „Monat").
 * Bekannte Wörter werden auf den Code abgebildet, den die Auswahl kennt; alles
 * andere bleibt unverändert stehen und erscheint als eigener Eintrag
 * (`unitOptions`), damit nichts stillschweigend umgeschrieben wird.
 */
const UNIT_WORDS: Record<string, string> = {
  stück: 'C62',
  stueck: 'C62',
  stk: 'C62',
  'stk.': 'C62',
  monat: 'MON',
  monate: 'MON',
  jahr: 'ANN',
  pauschal: 'LS',
  pauschale: 'LS',
};

function normalizeUnit(unit: string | null): string {
  if (unit === null || unit.trim() === '') return 'C62';
  return UNIT_WORDS[unit.trim().toLowerCase()] ?? unit;
}

/** Auswahlliste einer Zeile: die festen Einheiten, bei fremdem Wert dieser dazu. */
function unitOptions(current: string): { value: string; label: string }[] {
  return UNITS.some((u) => u.value === current)
    ? UNITS
    : [...UNITS, { value: current, label: current }];
}

/** Längste Einheit, die der Server annimmt. */
const UNIT_MAX_LENGTH = 3;

/**
 * Ordnet eine Prüfmeldung des Servers dem Eingabefeld zu.
 *
 * `key` ist der Schlüssel in `fieldError`, `focusId` das Element, das den
 * Fokus bekommt, `expand` der Posten, dessen „Weitere Angaben" dafür offen sein
 * müssen. `null`, wenn das Formular dazu kein Feld hat (dann steht die Meldung
 * nur in der Zusammenfassung). `rank` bestimmt, welches Feld zuerst den Fokus
 * bekommt: Posten in Lesereihenfolge, danach die Kopfangaben.
 */
interface FieldTarget {
  key: string;
  focusId: string;
  expand: string | null;
  rank: number;
}

const LINE_FIELDS: Record<string, { suffix: string; focus: string; weitere: boolean; rank: number }> = {
  label: { suffix: 'bezeichnung', focus: 'bezeichnung', weitere: false, rank: 0 },
  periodFrom: { suffix: 'zeitraum', focus: 'zeitraum-von', weitere: false, rank: 1 },
  periodUntil: { suffix: 'zeitraum', focus: 'zeitraum-bis', weitere: false, rank: 2 },
  quantity: { suffix: 'menge', focus: 'menge', weitere: false, rank: 3 },
  unitPriceNetCent: { suffix: 'einzelpreis', focus: 'einzelpreis', weitere: false, rank: 4 },
  taxRate: { suffix: 'steuersatz', focus: 'steuersatz', weitere: false, rank: 5 },
  description: { suffix: 'beschreibung', focus: 'beschreibung', weitere: true, rank: 6 },
  unit: { suffix: 'einheit', focus: 'einheit', weitere: true, rank: 7 },
};

const HEAD_FIELDS: Record<string, { key: string; focusId: string; rank: number }> = {
  invoiceDate: { key: 'rechnung-rechnungsdatum', focusId: 'rechnung-rechnungsdatum', rank: 1000 },
  servicePeriodFrom: { key: 'period-from', focusId: 'rechnung-zeitraum-von', rank: 1001 },
  servicePeriodUntil: { key: 'period', focusId: 'rechnung-zeitraum-bis', rank: 1002 },
  dueDate: { key: 'rechnung-faelligkeit', focusId: 'rechnung-faelligkeit', rank: 1003 },
  introduction: { key: 'rechnung-einleitung', focusId: 'rechnung-einleitung', rank: 1004 },
  paymentNote: { key: 'rechnung-zahlungshinweis', focusId: 'rechnung-zahlungshinweis', rank: 1005 },
  internalNote: { key: 'rechnung-interne-notiz', focusId: 'rechnung-interne-notiz', rank: 1006 },
};

function targetFor(issue: ValidationIssue, lines: LinesDraft[]): FieldTarget | null {
  if (issue.field === null) return null;
  if (issue.index !== null) {
    const line = lines[issue.index];
    const spec = LINE_FIELDS[issue.field];
    if (line === undefined || spec === undefined) return null;
    return {
      key: `${line.key}-${spec.suffix}`,
      focusId: `${line.key}-${spec.focus}`,
      expand: spec.weitere ? line.key : null,
      rank: issue.index * 10 + spec.rank,
    };
  }
  const head = HEAD_FIELDS[issue.field];
  return head === undefined ? null : { key: head.key, focusId: head.focusId, expand: null, rank: head.rank };
}

/**
 * Das Entwurfsformular einer Rechnung.
 *
 * KEINE `Tabelle` FÜR DIE POSTEN. Fünf Eingabefelder je Zeile und
 * `table-layout` vertragen sich bei 375 px nicht; es entstünde genau die
 * waagerecht scrollende Bearbeitungsfläche, die in Etappe 2 zurückgewiesen
 * wurde. Stattdessen gestapelte Postenkarten, die untereinander umbrechen.
 *
 * DAS FESTSCHREIBEN STEHT ÜBER DER FUSSLEISTE, nicht daneben: Unterschiedliches
 * Gewicht braucht unterschiedliche Position. Der Erklärsatz dazu steht immer
 * da, nicht erst beim Überfahren — es ist genau die Sorte Information, die man
 * VOR dem ersten Mal lesen soll.
 *
 * „ENTWURF LÖSCHEN" STEHT UNTEN UND KLEIN, nicht neben „Speichern": Primäre
 * und zerstörende Handlung treffen in dieser Anwendung nirgends aufeinander.
 */
export function InvoiceDraftForm({
  company,
  invoice,
  totpPossible,
  suggestion,
  suggestionError,
  onSaved,
  onCancel,
  onDeleted,
  onFinalized,
}: {
  company: Company;
  /** `null` = Neuanlage; es existiert noch nichts auf dem Server. */
  invoice: Invoice | null;
  /** Weitergereicht an den Festschreib-Dialog für dessen Nachweis-Dialog. */
  totpPossible: boolean;
  suggestion: PriceSuggestion | null;
  suggestionError: string | null;
  onSaved: (invoice: Invoice, isNew: boolean, message: boolean) => void;
  onCancel: () => void;
  onDeleted: () => void;
  onFinalized: (invoice: Invoice) => void;
}) {
  const t = useT();
  const toast = useToast();
  const isNew = invoice === null;

  const [invoiceDate, setInvoiceDate] = useState(
    () => invoice?.invoiceDate ?? today(),
  );
  const [period, setPeriod] = useState(() =>
    invoice === null
      ? servicePeriodSuggestion(company.paymentInterval)
      : {
          from: invoice.servicePeriodFrom,
          until: invoice.servicePeriodUntil,
        },
  );
  // Beim Entwurf hat der Server bereits gerechnet; das Feld zeigt den
  // gerechneten Wert und lässt sich überschreiben. Bei der Neuanlage bleibt es
  // leer, damit der Server rechnet.
  const [dueDate, setDueDate] = useState(
    () => invoice?.dueDate ?? '',
  );
  // Die drei Texte des Bearbeiten-Screens. Einleitung und Zahlungshinweis
  // stehen auf dem BELEG und werden mit dem Festschreiben unveraenderlich;
  // die interne Notiz steht auf keinem Beleg und geht in keine Mail.
  const [introduction, setIntroduction] = useState(
    () => invoice?.introduction ?? '',
  );
  const [paymentNote, setPaymentNote] = useState(
    () => invoice?.paymentNote ?? '',
  );
  const [internalNote, setInternalNote] = useState(
    () => invoice?.internalNote ?? '',
  );
  const [lines, setLines] = useState<LinesDraft[]>(() =>
    invoice === null ? [emptyLines()] : linesFrom(invoice),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  /** Zusammenfassung oben: eine Zeile je fehlerhafter Angabe. */
  const [summary, setSummary] = useState<string[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  /** Welches Feld den Fokus bekommen soll; `n` zählt, damit dasselbe Feld erneut greift. */
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Wechselt die Rechnung (Neuanlage → gespeicherter Entwurf), zieht das
  // Formular nach: Der Server kann Werte gerechnet haben, die es nicht kennt.
  useEffect(() => {
    if (invoice === null) return;
    setInvoiceDate(invoice.invoiceDate);
    setPeriod({
      from: invoice.servicePeriodFrom,
      until: invoice.servicePeriodUntil,
    });
    setDueDate(invoice.dueDate);
  }, [invoice]);

  // Fokus erst nach dem Rendern setzen: Das Feld kann hinter „Weitere Angaben"
  // liegen, das im selben Schritt erst aufklappt.
  useEffect(() => {
    if (focusRequest === null) return;
    const element = document.getElementById(focusRequest.id);
    if (element instanceof HTMLElement) element.focus();
  }, [focusRequest]);

  function requestFocus(id: string, expand: string | null) {
    if (expand !== null) setExpanded((alt) => new Set(alt).add(expand));
    setFocusRequest((alt) => ({ id, n: (alt?.n ?? 0) + 1 }));
  }

  /**
   * Prüfmeldungen des Servers ans Feld setzen, Fokus aufs erste fehlerhafte
   * Feld, Zusammenfassung oben. `false`, wenn der Fehler keine Eingabeprüfung
   * war (dann bleibt es beim Text unter dem Formular).
   */
  function showServerIssues(f: unknown): boolean {
    const issues = validationIssues(f);
    if (issues.length === 0) return false;
    const errorList: Record<string, string> = {};
    let first: FieldTarget | null = null;
    const toExpand: string[] = [];
    for (const issue of issues) {
      const target = targetFor(issue, lines);
      if (target === null) continue;
      // Jede Meldung muss sichtbar sein, auch die hinter „Weitere Angaben".
      if (target.expand !== null) toExpand.push(target.expand);
      errorList[target.key] ??= issue.message;
      if (first === null || target.rank < first.rank) first = target;
    }
    setFieldError(errorList);
    setSummary(issues.map(issueLine));
    setError(null);
    if (toExpand.length > 0) setExpanded((alt) => new Set([...alt, ...toExpand]));
    if (first !== null) requestFocus(first.focusId, first.expand);
    else summaryRef.current?.focus();
    return true;
  }

  function linesChange(
    key: string,
    field: keyof LinesDraft,
    value: string,
  ) {
    setLines((alt) =>
      alt.map((p) => (p.key === key ? { ...p, [field]: value } : p)),
    );
  }

  function linesAdd() {
    setLines((alt) =>
      alt.length >= LINES_MAX_COUNT ? alt : [...alt, emptyLines()],
    );
  }

  function linesRemove(key: string) {
    setLines((alt) =>
      alt.length === 1 ? alt : alt.filter((p) => p.key !== key),
    );
  }

  /**
   * R5: Der Vorschlag wird ÜBERNOMMEN, nie vorbelegt.
   *
   * Der Klick fügt einen neuen Posten HINZU und ersetzt nichts. Ist nur die
   * eine leere Startzeile da, wird sie ersetzt — sonst stünde nach dem ersten
   * Klick eine leere Pflichtzeile im Weg, die das Speichern blockiert.
   */
  function adopt(template: AdoptionLines) {
    const newValue: LinesDraft = {
      ...emptyLines(),
      label: template.label,
      unitPriceNet: centAsFieldValue(template.unitPriceNetCent),
      unit: template.unit,
      priceTierKey: template.priceTierKey,
    };
    setLines((alt) => {
      const onlyEmptyStartRow =
        alt.length === 1 &&
        alt[0] !== undefined &&
        alt[0].label.trim() === '' &&
        alt[0].unitPriceNet.trim() === '';
      return onlyEmptyStartRow ? [newValue] : [...alt, newValue];
    });
    toast.show(t('components.invoiceDraftForm.text', { label: template.label }));
  }

  /** Prüft die Eingaben, bevor der Server sie ablehnt. Gibt die DTO-Posten zurück. */
  function checkAndBuild(): InvoiceLineInput[] | null {
    const errorList: Record<string, string> = {};
    const dto: InvoiceLineInput[] = [];

    for (const p of lines) {
      if (p.label.trim() === '') {
        errorList[`${p.key}-bezeichnung`] =
          t('components.invoiceDraftForm.text2');
      }
      const quantity = Number(p.quantity.trim().replace(',', '.'));
      if (!Number.isFinite(quantity) || quantity === 0) {
        errorList[`${p.key}-menge`] =
          t('components.invoiceDraftForm.text3');
      }
      const unitPriceCent = centFromInput(p.unitPriceNet);
      if (unitPriceCent === null) {
        errorList[`${p.key}-einzelpreis`] =
          t('components.invoiceDraftForm.text4');
      }
      const taxRate = Number(p.taxRate.trim().replace(',', '.'));
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        errorList[`${p.key}-steuersatz`] =
          t('components.invoiceDraftForm.text5');
      }

      if (p.unit.length > UNIT_MAX_LENGTH) {
        errorList[`${p.key}-einheit`] = t('components.invoiceDraftForm.unitInvalid');
      }

      // BEIDE ODER KEINER. Der Server weist einen halben Zeitraum ab; ihn hier
      // still wegzulassen hiesse, eine Eingabe der Betreiberin zu verschlucken.
      const half =
        (p.periodFrom === '') !== (p.periodUntil === '');
      if (half) {
        errorList[`${p.key}-zeitraum`] =
          t('components.invoiceDraftForm.text6');
      } else if (
        p.periodFrom !== '' &&
        p.periodUntil < p.periodFrom
      ) {
        errorList[`${p.key}-zeitraum`] =
          t('components.invoiceDraftForm.text7');
      }

      if (Object.keys(errorList).length === 0 && unitPriceCent !== null) {
        dto.push({
          label: p.label.trim(),
          ...(p.description.trim() === ''
            ? {}
            : { description: p.description.trim() }),
          ...(p.periodFrom === '' || p.periodUntil === ''
            ? {}
            : { periodFrom: p.periodFrom, periodUntil: p.periodUntil }),
          quantity,
          unitPriceNetCent: unitPriceCent,
          taxRate,
          unit: p.unit,
          ...(p.priceTierKey === '' ? {} : { priceTierKey: p.priceTierKey }),
        });
      }
    }

    if (period.until < period.from) {
      errorList['period'] =
        t('components.invoiceDraftForm.text8');
    }

    setFieldError(errorList);
    setSummary([]);
    const firstKey = Object.keys(errorList)[0];
    if (firstKey !== undefined) {
      // Die Schlüssel entsprechen den Feld-IDs, nur der Zeitraum und die
      // Kopfzeile des Leistungszeitraums tragen eine andere.
      const focusId = firstKey.endsWith('-zeitraum')
        ? `${firstKey}-von`
        : firstKey === 'period'
          ? 'rechnung-zeitraum-bis'
          : firstKey;
      requestFocus(focusId, firstKey.endsWith('-einheit') ? firstKey.slice(0, -'-einheit'.length) : null);
    }
    return Object.keys(errorList).length === 0 ? dto : null;
  }

  /**
   * @param meldung Sichtbare Rückmeldung zeigen? Beim stillen Vorab-Speichern
   *   vor der Festschreib-Vorschau ausdrücklich NICHT — siehe
   *   `speichernUndVorschau`.
   */
  async function save(message = true): Promise<Invoice | null> {
    const dtoLines = checkAndBuild();
    if (dtoLines === null) {
      setError(t('components.invoiceDraftForm.text9'));
      return null;
    }
    setLoading(true);
    setError(null);
    setSummary([]);
    try {
      const body = {
        invoiceDate,
        servicePeriodFrom: period.from,
        servicePeriodUntil: period.until,
        ...(dueDate === '' ? {} : { dueDate }),
        lines: dtoLines,
        // Leere Felder werden als leerer Text geschickt, NICHT weggelassen:
        // Wer einen Einleitungssatz wieder herausnimmt, will ihn weg haben.
        // Der Dienst macht daraus `null`.
        introduction,
        paymentNote,
        internalNote,
      };
      const saved =
        invoice === null
          ? await createInvoiceDraft(company.id, body)
          : await updateInvoiceDraft(invoice.id, body);
      onSaved(saved, invoice === null, message);
      return saved;
    } catch (f) {
      // Das Formular bleibt vollständig erhalten — kein Datenverlust bei einem
      // Serverfehler.
      if (!showServerIssues(f)) {
        setError(errorText(f, t('components.invoiceDraftForm.text10')));
      }
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * „Festschreiben …" SPEICHERT ZUERST — und zwar STILL.
   *
   * Zuerst speichern, weil die Vorschau sonst den Stand des Servers zeigte,
   * während im Formular daneben etwas anderes steht — und festgeschrieben
   * würde der Serverstand. Genau der Fall, den die Vorschau verhindern soll:
   * Man prüft eine Zahl und bekommt eine andere. Scheitert das Speichern,
   * bleibt der Dialog zu und der Fehler steht im Formular.
   *
   * OHNE ERFOLGSMELDUNG, und das ist kein Schönheitsgrund. Gemessen bei
   * 375 × 700 px im Browser: Der Toast steht `fixed bottom-4 right-4` und wird
   * nach dem Dialog in den Baum gehängt — er liegt also darüber. Bei einem
   * Fenster, das kürzer ist als der Dialog, endet dessen Fußleiste genau dort,
   * und `document.elementFromPoint` traf an allen drei Punkten des Knopfes
   * „Jetzt festschreiben" den Toast statt des Knopfes. Der Klick ging ins
   * Leere; kein Test hätte das gezeigt, weil in jsdom nichts übereinander
   * liegt.
   *
   * Der Toast wäre hier ohnehin die falsche Auskunft: Wer „Festschreiben …"
   * drückt, will nicht lesen, dass ein Entwurf gespeichert wurde. Das
   * Speichern ist ein Zwischenschritt, kein Ergebnis.
   */
  async function saveAndPreview() {
    const saved = await save(false);
    if (saved !== null) setPreviewOpen(true);
  }

  async function deleteIt() {
    if (invoice === null) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await deleteInvoiceDraft(invoice.id);
      onDeleted();
    } catch (f) {
      setDeleteError(
        errorText(f, t('components.invoiceDraftForm.text11')),
      );
    } finally {
      setDeleteLoading(false);
    }
  }

  const total = sums(lines);

  return (
    <>
      {summary.length > 0 && (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 rounded-lg border border-einwand-rahmen-hell bg-einwand-bg p-3 text-sm text-einwand-text focus:outline-none"
        >
          <p className="font-semibold">{t('common.validation.count', { count: summary.length })}</p>
          <ul className="mt-1 list-inside list-disc">
            {summary.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ZWEISPALTIG NACH ENTWURF: links, was den Inhalt der Rechnung
          ausmacht (Posten, Texte), rechts die Rahmendaten. Die rechte Spalte
          bleibt beim Scrollen stehen — wer unten an den Posten arbeitet, soll
          Nummer und Fälligkeit im Blick behalten.

          Ab 1100 px bricht sie auf eine Spalte um; darunter ist Nebeneinander
          keine Hilfe mehr, sondern zwei zu schmale Spalten. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <InvoicePriceSuggestion
            suggestion={suggestion}
            loadError={suggestionError}
            onAdopt={adopt}
          />

          <Card className="mt-4 p-[18px]">
            <h2 className="mb-4 text-[17px] font-semibold text-text">
              {t('components.invoiceDraftForm.heading')}</h2>

            {lines.map((p, i) => {
              const amounts = linesAmounts(p);
              const open = expanded.has(p.key);
              return (
                <div
                  key={p.key}
                  className="mb-4 rounded-lg border border-rahmen p-4 last:mb-0"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-leise">
                      {t('components.invoiceDraftForm.label4')}{i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => linesRemove(p.key)}
                      disabled={lines.length === 1}
                      aria-label={t('components.invoiceDraftForm.ariaLabel', { value: i + 1 })}
                      title={
                        lines.length === 1
                          ? t('components.invoiceDraftForm.title')
                          : t('components.invoiceDraftForm.title2')
                      }
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-leise transition-colors hover:bg-flaeche-3 hover:text-gefahr disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-leise"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  <InputField
                    id={`${p.key}-bezeichnung`}
                    label={t('components.invoiceDraftForm.label5')}
                    value={p.label}
                    maxLength={200}
                    onChange={(ev) =>
                      linesChange(p.key, 'label', ev.target.value)
                    }
                    error={fieldError[`${p.key}-bezeichnung`]}
                  />

                  {/* DER ZEITRAUM STEHT OFFEN, nicht im Aufklapper. Der
                      Entwurf führt ihn als eigene Spalte der Positionstabelle,
                      und das trifft die Sache: Er sagt, WOFÜR abgerechnet
                      wird. Beschreibung und Einheit sind Beiwerk und bleiben
                      hinter „Weitere Angaben". */}
                  <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                    <DateField
                      id={`${p.key}-zeitraum-von`}
                      label={t('components.invoiceDraftForm.label6')}
                      value={p.periodFrom}
                      onChange={(value) =>
                        linesChange(p.key, 'periodFrom', value)
                      }
                    />
                    <DateField
                      id={`${p.key}-zeitraum-bis`}
                      label={t('components.invoiceDraftForm.label7')}
                      value={p.periodUntil}
                      onChange={(value) =>
                        linesChange(p.key, 'periodUntil', value)
                      }
                      error={fieldError[`${p.key}-zeitraum`]}
                    />
                  </div>

                  {/* `items-end`, weil „Einzelpreis netto (EUR)" zweizeilig
                      umbricht und sein Feld sonst tiefer stünde als die
                      Nachbarn. Ausgerichtet wird an den EINGABEN, nicht an
                      den Beschriftungen — der Blick folgt der Zeile. */}
                  <div className="grid grid-cols-2 items-end gap-x-3 sm:grid-cols-4">
                    <InputField
                      id={`${p.key}-menge`}
                      label={t('components.invoiceDraftForm.label8')}
                      type="number"
                      step="0.001"
                      inputMode="decimal"
                      value={p.quantity}
                      onChange={(ev) =>
                        linesChange(p.key, 'quantity', ev.target.value)
                      }
                      error={fieldError[`${p.key}-menge`]}
                    />
                    <InputField
                      id={`${p.key}-einzelpreis`}
                      label={t('components.invoiceDraftForm.label9')}
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={p.unitPriceNet}
                      onChange={(ev) =>
                        linesChange(
                          p.key,
                          'unitPriceNet',
                          ev.target.value,
                        )
                      }
                      error={fieldError[`${p.key}-einzelpreis`]}
                    />
                    <InputField
                      id={`${p.key}-steuersatz`}
                      label={t('components.invoiceDraftForm.label10')}
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={p.taxRate}
                      onChange={(ev) =>
                        linesChange(p.key, 'taxRate', ev.target.value)
                      }
                      error={fieldError[`${p.key}-steuersatz`]}
                    />
                    <div className="mb-4 text-left">
                      <span className="mb-1 block text-sm font-medium text-text">
                        {t('components.invoiceDraftForm.label11')}</span>
                      <p className="ziffern-tabellarisch px-3 py-2 text-sm text-leise">
                        {amounts.complete
                          ? formatAmountCent(amounts.grossCent)
                          : '—'}
                      </p>
                    </div>
                  </div>

                  {/* Beschreibung, Zeitraum und Einheit sind optional und stehen
                      deshalb hinter einem Aufklapper — in der Grundzeile überlüden
                      sie die Karte bei 375 px. */}
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`${p.key}-weitere`}
                    onClick={() =>
                      setExpanded((alt) => {
                        const newValue = new Set(alt);
                        if (newValue.has(p.key)) newValue.delete(p.key);
                        else newValue.add(p.key);
                        return newValue;
                      })
                    }
                    className={`text-sm ${TEXT_BUTTON_ACTION}`}
                  >
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                    {t('components.invoiceDraftForm.button')}</button>
                  {open && (
                    <div id={`${p.key}-weitere`} className="mt-3">
                      <InputField
                        id={`${p.key}-beschreibung`}
                        label={t('components.invoiceDraftForm.label12')}
                        value={p.description}
                        maxLength={600}
                        onChange={(ev) =>
                          linesChange(
                            p.key,
                            'description',
                            ev.target.value,
                          )
                        }
                        error={fieldError[`${p.key}-beschreibung`]}
                      />
                      <SelectField
                        id={`${p.key}-einheit`}
                        label={t('components.invoiceDraftForm.label13')}
                        value={p.unit}
                        onChange={(value) =>
                          linesChange(p.key, 'unit', value)
                        }
                        error={fieldError[`${p.key}-einheit`]}
                      >
                        {unitOptions(p.unit).map((e) => (
                          <option key={e.value} value={e.value}>
                            {e.label}
                          </option>
                        ))}
                      </SelectField>
                    </div>
                  )}
                </div>
              );
            })}

            <Button
              variant="secondary"
              className="mt-4"
              onClick={linesAdd}
              disabled={lines.length >= LINES_MAX_COUNT}
              title={
                lines.length >= LINES_MAX_COUNT
                  ? t('components.invoiceDraftForm.title3', { LINES_MAX_COUNT: LINES_MAX_COUNT })
                  : undefined
              }
            >
              <PlusCircle className="h-4 w-4" aria-hidden="true" />
              {t('components.invoiceDraftForm.button2')}</Button>

            <dl className="mt-4 flex flex-col items-end gap-1 border-t border-rahmen pt-4 text-sm">
              <div className="flex gap-3">
                <dt className="text-leise">{t('components.invoiceDraftForm.text12')}</dt>
                <dd className="ziffern-tabellarisch">
                  {formatAmountCent(total.netCent)}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-leise">{t('components.invoiceDraftForm.text13')}</dt>
                <dd className="ziffern-tabellarisch">
                  {formatAmountCent(total.taxCent)}
                </dd>
              </div>
              <div className="flex gap-3 text-base font-semibold">
                <dt>{t('components.invoiceDraftForm.text14')}</dt>
                <dd className="ziffern-tabellarisch">
                  {formatAmountCent(total.grossCent)}
                </dd>
              </div>
            </dl>
            <p className="mt-1 text-right text-xs text-leise">
              {t('components.invoiceDraftForm.text15')}</p>
          </Card>

          {/* ------------------------------------- Text auf der Rechnung */}
          <Card className="mt-4 p-[18px]">
            <h2 className="mb-3 text-[17px] font-semibold text-text">
              {t('components.invoiceDraftForm.heading2')}</h2>
            <TextArea
              id="rechnung-einleitung"
              label={t('components.invoiceDraftForm.label14')}
              value={introduction}
              onChange={setIntroduction}
              error={fieldError['rechnung-einleitung']}
              rows={3}
              helperText={t('components.invoiceDraftForm.helperText')}
            />
            <InputField
              id="rechnung-zahlungshinweis"
              label={t('components.invoiceDraftForm.label15')}
              value={paymentNote}
              maxLength={500}
              onChange={(ev) => setPaymentNote(ev.target.value)}
              error={fieldError['rechnung-zahlungshinweis']}
              helperText={t('components.invoiceDraftForm.helperText2')}
            />
          </Card>
        </div>

        {/* ------------------------------------------- Rechte Spalte */}
        <div className="min-w-0 xl:sticky xl:top-[78px] xl:self-start">
          <Card className="p-[18px]">
            <h2 className="mb-3 text-[17px] font-semibold text-text">
              {t('components.invoiceDraftForm.heading3')}</h2>

            {/* DIE NUMMER IST GESPERRT UND LEER, solange die Rechnung Entwurf
                ist. Eine vorläufige Nummer anzuzeigen wäre eine Zusage: Der
                Nummernkreis vergibt erst beim Festschreiben, und zwar nach
                dem RECHNUNGSDATUM — wer das Datum noch ändert, bekäme eine
                andere Nummer als die angezeigte. */}
            <InputField
              id="rechnung-nummer"
              label={t('components.invoiceDraftForm.label16')}
              value={invoice?.invoiceNumber ?? ''}
              placeholder={t('components.invoiceDraftForm.placeholder')}
              readOnly
              disabled
              onChange={() => {}}
              className="bg-flaeche-3"
            />

            <DateField
              id="rechnung-rechnungsdatum"
              label={t('components.invoiceDraftForm.label17')}
              value={invoiceDate}
              onChange={setInvoiceDate}
              required
              error={fieldError['rechnung-rechnungsdatum']}
            />
            <DateField
              id="rechnung-zeitraum-von"
              label={t('components.invoiceDraftForm.label18')}
              value={period.from}
              onChange={(value) => setPeriod((z) => ({ ...z, from: value }))}
              required
              error={fieldError['period-from']}
            />
            <DateField
              id="rechnung-zeitraum-bis"
              label={t('components.invoiceDraftForm.label19')}
              value={period.until}
              onChange={(value) => setPeriod((z) => ({ ...z, until: value }))}
              required
              error={fieldError['period']}
            />
            <DateField
              id="rechnung-faelligkeit"
              label={t('components.invoiceDraftForm.label20')}
              value={dueDate}
              onChange={setDueDate}
              helperText={t('components.invoiceDraftForm.helperText3')}
              error={fieldError['rechnung-faelligkeit']}
            />

            <p className="mt-2 flex items-start gap-2 text-[13px] text-still">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('components.invoiceDraftForm.text16')}</p>
          </Card>

          {/* ------------------------------------------- Interne Notiz */}
          <Card className="mt-4 p-[18px]">
            <h2 className="mb-3 text-[17px] font-semibold text-text">
              {t('components.invoiceDraftForm.heading4')}</h2>
            <TextArea
              id="rechnung-interne-notiz"
              label={t('components.invoiceDraftForm.label21')}
              value={internalNote}
              onChange={setInternalNote}
              error={fieldError['rechnung-interne-notiz']}
              rows={3}
              helperText={t('components.invoiceDraftForm.helperText4')}
            />
            {invoice !== null && (
              <Button
                variant="danger"
                className="w-full"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('components.invoiceDraftForm.button3')}</Button>
            )}
          </Card>
        </div>
      </div>

      {/* Festschreiben: eigener, abgesetzter Block ÜBER der Fußleiste. Erst
          möglich, wenn der Entwurf auf dem Server existiert. */}
      {invoice !== null && (
        <div className="mt-6 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <p className="text-sm text-text">
            {t('components.invoiceDraftForm.text17')}</p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="secondaryGreen"
              loading={loading}
              onClick={() => void saveAndPreview()}
            >
              {t('components.invoiceDraftForm.button4')}</Button>
            <HelpHint text={t('components.invoiceDraftForm.finalizeHint')} />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-gefahr">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={loading}
          type="button"
        >
          {t('components.invoiceDraftForm.button5')}</Button>
        <Button loading={loading} onClick={() => void save()} type="button">
          {isNew ? t('components.invoiceDraftForm.button6') : t('components.invoiceDraftForm.button7')}
        </Button>
      </div>

      {/* „Entwurf verwerfen" steht seit dem Redesign in der rechten Spalte,
          bei der internen Notiz — dort, wo der Entwurf als Vorgang endet.
          Zweimal derselbe Weg wäre einmal zu viel. */}

      {invoice !== null && (
        <>
          <Dialog
            open={deleteOpen}
            title={t('components.invoiceDraftForm.title4')}
            size="sm"
            onClose={() => {
              if (!deleteLoading) setDeleteOpen(false);
            }}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setDeleteOpen(false)}
                  disabled={deleteLoading}
                >
                  {t('components.invoiceDraftForm.button5')}</Button>
                <Button
                  variant="danger"
                  loading={deleteLoading}
                  onClick={() => void deleteIt()}
                >
                  {t('components.invoiceDraftForm.button8')}</Button>
              </>
            }
          >
            <p className="text-sm text-text">
              {t('components.invoiceDraftForm.text18')}</p>
            {deleteError && (
              <p role="alert" className="mt-2 text-sm text-gefahr">
                {deleteError}
              </p>
            )}
          </Dialog>

          <InvoiceFinalizeDialog
            open={previewOpen}
            invoice={invoice}
            company={company}
            totpPossible={totpPossible}
            onClose={() => setPreviewOpen(false)}
            onFinalized={(fixed) => {
              setPreviewOpen(false);
              onFinalized(fixed);
            }}
          />
        </>
      )}
    </>
  );
}
