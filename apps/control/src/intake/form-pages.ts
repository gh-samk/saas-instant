import { escapeHtml, pagesFoot, pagesHeader } from '../consent/pages';
import {
  allFields,
  needsMandate,
  checkPaymentPairingInForm,
  CheckStep,
  Steps,
  STEPS_TOTAL,
  type Field,
} from './steps';
import { mandateText } from './mandate-text';

/**
 * ===========================================================================
 * DIE SEITEN DES AUFNAHMEFORMULARS
 * ===========================================================================
 *
 * Kopf und Fuss kommen aus `consent/seiten.ts` — dieselbe Huelle, damit
 * die Zusagen dort auch hier gelten: kein JavaScript, keine Fremdressource,
 * `noindex`, Hausschrift, Wortmarke, Rechtsverweise.
 *
 * DER ZUSTAND REIST IM FORMULAR. Jeder Schritt traegt die Angaben aller
 * vorherigen als `<input type="hidden">` mit. Kein Serverspeicher, keine
 * Sitzung, kein Cookie.
 *
 * DIE IBAN IST DIE EINE AUSNAHME: Sie wird in der Pruefansicht nur MASKIERT
 * gezeigt. Sie reist zwar als versteckter Wert mit — anders geht es ohne
 * Zwischenspeicher nicht —, aber sie soll nicht in einem Fenster stehen, das
 * jemand offen liegen laesst. Dazu `Cache-Control: no-store` am Controller
 * und `autocomplete="off"` am Feld. Wer das fuer einen Fehler haelt und die
 * Maskierung entfernt, moege diesen Absatz lesen.
 */

/** Die eingegebenen Werte, Feldname auf Wert. */
export type Inputs = Readonly<Record<string, string>>;

/** Ein Fehler an einem bestimmten Feld. */
export interface FieldError {
  field: string;
  message: string;
}

/** `DE89 •••• •••• •••• •••• 34` — erkennbar, aber nicht lesbar. */
export function maskIban(iban: string): string {
  const raw = iban.replace(/\s+/g, '');
  if (raw.length < 8) return '••••';
  return `${raw.slice(0, 4)} ${'•'.repeat(4)} ${'•'.repeat(4)} ${raw.slice(-2)}`;
}

function errorTo(field: string, error: readonly FieldError[]): string | null {
  return error.find((f) => f.field === field)?.message ?? null;
}

/** Ein einzelnes Eingabefeld samt Beschriftung, Hinweis und Fehlermeldung. */
function fieldHtml(
  field: Field,
  inputs: Inputs,
  error: readonly FieldError[],
): string {
  const value = inputs[field.name] ?? '';
  const message = errorTo(field.name, error);
  const id = `f-${field.name}`;
  const hintId = field.hint ? `${id}-hinweis` : null;
  const errorId = message ? `${id}-error` : null;
  const described = [hintId, errorId].filter(Boolean).join(' ');

  if (field.kind === 'checkbox') {
    return [
      '<div class="sl-field sl-checkbox">',
      '<label>',
      `<input type="checkbox" id="${id}" name="${escapeHtml(field.name)}" value="ja"`,
      value === 'ja' ? ' checked' : '',
      '>',
      `<span>${escapeHtml(field.label)}</span>`,
      '</label>',
      message ? `<p class="sl-error" id="${errorId}">${escapeHtml(message)}</p>` : '',
      '</div>',
    ].join('');
  }

  if (field.kind === 'select') {
    return [
      '<div class="sl-field">',
      `<label for="${id}">${escapeHtml(field.label)}`,
      field.required ? ' <span aria-hidden="true">*</span>' : '',
      '</label>',
      `<select id="${id}" name="${escapeHtml(field.name)}"`,
      described ? ` aria-describedby="${described}"` : '',
      '>',
      '<option value="">Bitte wählen</option>',
      ...(field.options ?? []).map(
        (o) =>
          `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>` +
          `${escapeHtml(o.text)}</option>`,
      ),
      '</select>',
      field.hint ? `<p class="sl-hint" id="${hintId}">${escapeHtml(field.hint)}</p>` : '',
      message ? `<p class="sl-error" id="${errorId}">${escapeHtml(message)}</p>` : '',
      '</div>',
    ].join('');
  }

  // Die IBAN wird NICHT vorbelegt und nicht vom Browser gemerkt.
  const isIban = field.name === 'iban';
  return [
    '<div class="sl-field">',
    `<label for="${id}">${escapeHtml(field.label)}`,
    field.required ? ' <span aria-hidden="true">*</span>' : '',
    '</label>',
    `<input type="${field.kind}" id="${id}" name="${escapeHtml(field.name)}"`,
    ` value="${escapeHtml(isIban ? '' : value)}"`,
    isIban ? ' autocomplete="off"' : field.autocomplete ? ` autocomplete="${field.autocomplete}"` : '',
    described ? ` aria-describedby="${described}"` : '',
    '>',
    field.hint ? `<p class="sl-hint" id="${hintId}">${escapeHtml(field.hint)}</p>` : '',
    message ? `<p class="sl-error" id="${errorId}">${escapeHtml(message)}</p>` : '',
    '</div>',
  ].join('');
}

/**
 * Alle bisherigen Eingaben als versteckte Felder — OHNE die des aktuellen
 * Schritts, die stehen ja als sichtbare da.
 */
function hidden(inputs: Inputs, visible: readonly Field[]): string {
  const notShow = new Set(visible.map((f) => f.name));
  return Object.entries(inputs)
    .filter(([name, value]) => !notShow.has(name) && value !== '')
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
}

/** Das zusätzliche Stylesheet der Formularseiten. */
const FORM_STYLE = [
  '<style>',
  '.sl-step-count{font-size:.8125rem;color:var(--farbe-text-leise);',
  'margin:0 0 .5rem;}',
  '.sl-field{margin:0 0 1rem;}',
  '.sl-field label{display:block;font-size:.9rem;font-weight:600;',
  'margin:0 0 .35rem;color:var(--farbe-text);}',
  '.sl-field label span{color:var(--farbe-primaer);}',
  '.sl-field input[type=text],.sl-field input[type=email],',
  '.sl-field input[type=tel],.sl-field select{width:100%;font:inherit;',
  // `box-sizing` steht in `pagesHeader()` global; ohne es ragten diese Felder
  // um Polsterung und Rahmen nach rechts heraus.
  'padding:.6rem .75rem;border:1px solid var(--farbe-rahmen);',
  'border-radius:8px;background:var(--farbe-flaeche);color:var(--farbe-text);}',
  '.sl-checkbox label{display:flex;align-items:flex-start;gap:.6rem;',
  'font-weight:400;font-size:.95rem;line-height:1.5;}',
  '.sl-checkbox input{width:18px;height:18px;margin:.15rem 0 0;padding:0;',
  'border:0;flex:0 0 auto;accent-color:var(--farbe-primaer);}',
  '.sl-hint{font-size:.8125rem;margin:.3rem 0 0;}',
  '.sl-error{font-size:.85rem;margin:.3rem 0 0;color:var(--farbe-gefahr);',
  'font-weight:600;}',
  '.sl-error-list{border:1px solid var(--farbe-gefahr);border-radius:8px;',
  'padding:.75rem 1rem;margin:0 0 1.25rem;}',
  '.sl-error-list p{margin:0 0 .35rem;color:var(--farbe-gefahr);',
  'font-weight:600;}',
  '.sl-error-list ul{margin:0;padding-left:1.1rem;',
  'color:var(--farbe-text-leise);}',
  '.sl-button-row{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.25rem;}',
  '.sl-secondary{background:var(--farbe-flaeche);color:var(--farbe-text);',
  'border-color:var(--farbe-rahmen);}',
  '.sl-check{margin:0 0 1.25rem;}',
  '.sl-check h2{font-size:1rem;margin:0 0 .4rem;',
  'font-family:inherit;font-weight:600;}',
  '.sl-check dl{margin:0;display:grid;grid-template-columns:auto 1fr;',
  'gap:.25rem 1rem;font-size:.9rem;}',
  '.sl-check dt{color:var(--farbe-text-leise);}',
  '.sl-check dd{margin:0;color:var(--farbe-text);}',
  // ===================================================================
  // DIE SCHRITTANZEIGE — Kreise mit Strichen dazwischen
  // ===================================================================
  //
  // Ohne sie stand nur „Schritt 3 von 6" da: eine Zahl, die sagt, wo man
  // ist, aber nicht zeigt, wie weit es noch ist. Gewuenscht am 07.09.2026.
  //
  // KEIN JAVASCRIPT und kein Bild — Kreise sind gerundete Kaesten, die
  // Striche sind Aussenlinien. Damit gilt hier dieselbe Zusage wie fuer die
  // ganze Seite.
  '.sl-steps{display:flex;align-items:center;margin:0 0 1.25rem;',
  'padding:0;list-style:none;}',
  '.sl-steps li{display:flex;align-items:center;flex:1 1 0;}',
  '.sl-steps li:last-child{flex:0 0 auto;}',
  '.sl-dot{flex:0 0 auto;width:1.75rem;height:1.75rem;border-radius:50%;',
  'display:flex;align-items:center;justify-content:center;',
  'font-size:.8125rem;font-weight:600;',
  'border:2px solid var(--farbe-rahmen);background:var(--farbe-flaeche);',
  'color:var(--farbe-text-leise);}',
  '.sl-line{flex:1 1 auto;height:2px;background:var(--farbe-rahmen);}',
  // ERLEDIGT und AKTUELL unterscheiden sich, sonst zeigte die Anzeige nur
  // eine Kette gleicher Kreise und beantwortete die Frage nicht, wegen der
  // es sie gibt.
  '.sl-dot.done{border-color:var(--farbe-primaer);',
  'background:var(--farbe-primaer);color:var(--farbe-flaeche);}',
  '.sl-line.done{background:var(--farbe-primaer);}',
  '.sl-dot.now{border-color:var(--farbe-primaer);',
  'color:var(--farbe-primaer);background:var(--farbe-flaeche);}',
  // ===================================================================
  // DER MANDATSKASTEN
  // ===================================================================
  '.sl-mandatee{border:1px solid var(--farbe-rahmen);border-radius:8px;',
  'padding:1rem;margin:0 0 1rem;background:var(--farbe-flaeche-2);}',
  '.sl-mandatee h3{margin:0 0 .5rem;font-size:.95rem;',
  'font-family:inherit;color:var(--farbe-text);}',
  // `pre-wrap`, damit die Absaetze und Zeilenumbrueche des Wortlauts stehen
  // bleiben — er ist ein Nachweis und wird nicht umformatiert.
  '.sl-mandatee pre{margin:0;font:inherit;font-size:.85rem;line-height:1.55;',
  'white-space:pre-wrap;color:var(--farbe-text-leise);}',
  '</style>',
].join('');

/**
 * Die Kette aus Kreisen und Strichen.
 *
 * `total` ist die Zahl der Schritte DIESES Weges: sechs mit Lastschrift,
 * fuenf ohne — der Mandatsschritt entfaellt dann, und eine Anzeige, die ihn
 * trotzdem zeigte, versprraeche einen Schritt, den es nicht gibt.
 */
function stepIndicator(now: number, total: number): string {
  const dots: string[] = [];
  for (let n = 1; n <= total; n += 1) {
    const state = n < now ? ' done' : n === now ? ' now' : '';
    dots.push(
      '<li>',
      `<span class="sl-dot${state}">${n}</span>`,
      n < total
        ? `<span class="sl-line${n < now ? ' done' : ''}"></span>`
        : '',
      '</li>',
    );
  }
  return [
    `<ol class="sl-steps" aria-label="Schritt ${now} von ${total}">`,
    ...dots,
    '</ol>',
  ].join('');
}

export interface StepPage {
  token: string;
  companyName: string;
  step: number;
  inputs: Inputs;
  error?: readonly FieldError[];
  /**
   * Glaeubigername und -kennung fuer den Mandatswortlaut. Sie stammen aus
   * `IssuerConfigService` und kommen deshalb vom Controller herein — die
   * Seiten sind reine Funktionen und lesen keine Konfiguration.
   */
  creditor?: { name: string; id: string };
}

/**
 * Wie viele Schritte dieser Weg hat.
 *
 * Ohne Lastschrift entfaellt der Mandatsschritt, und der Weg ist einen
 * Schritt kuerzer. „Schritt 5 von 6" zu schreiben, wenn nach dem vierten die
 * Pruefansicht kommt, waere schlicht falsch.
 *
 * SOLANGE NIEMAND GEWAEHLT HAT, GILT DER LAENGERE WEG. In Schritt 1 steht
 * die Zahlungsart noch nicht fest; sie leer zu lesen und daraus „von 5" zu
 * machen hiesse, den Mandatsschritt schon abzusagen, bevor jemand gefragt
 * wurde — und die Anzeige muesste spaeter von 5 auf 6 WACHSEN. Ein Zaehler,
 * der waehrend des Ausfuellens groesser wird, sieht aus wie ein Fehler.
 * Umgekehrt ist es harmlos: Wer „Überweisung" waehlt, sieht einen Schritt
 * WEGFALLEN, und das ist eine gute Nachricht.
 */
function stepsThisPath(inputs: Inputs): number {
  const kind = inputs['paymentMethod'];
  if (kind === undefined || kind === '' || needsMandate(kind)) return STEPS_TOTAL;
  // UND NUR, WENN DIE WAHL AUCH GILT. „Monatlich + Ueberweisung" wird
  // abgewiesen; den Weg trotzdem zu verkuerzen hiesse, auf derselben Seite die
  // Wahl abzulehnen und ihr zugleich zu folgen. Der Zaehler sprang dabei auf
  // „Schritt 4 von 5", waehrend darueber stand, dass es so nicht geht.
  if (checkPaymentPairingInForm(inputs['paymentInterval'], kind) !== null) {
    return STEPS_TOTAL;
  }
  return STEPS_TOTAL - 1;
}

/**
 * Die laufende Nummer dieses Schritts auf DIESEM Weg.
 *
 * Ohne Mandat ist die Pruefansicht (intern immer `6`) der fuenfte Schritt.
 */
function numberOnThisPath(step: number, inputs: Inputs): number {
  if (stepsThisPath(inputs) === STEPS_TOTAL) return step;
  return step === CheckStep ? STEPS_TOTAL - 1 : step;
}

/**
 * Der Mandatskasten ueber dem Haken: der Wortlaut, den die Kontoinhaberin
 * erteilt — aus DERSELBEN Funktion, aus der auch der gespeicherte Nachweis
 * entsteht.
 *
 * DIE MANDATSREFERENZ FEHLT HIER, und das ist richtig: Sie wird erst beim
 * Absenden vergeben, in derselben Transaktion wie das Schreiben. Sie vorher
 * zu erfinden hiesse, eine Nummer zu zeigen, die eine andere sein kann —
 * oder den Nummernkreis vor der Zustimmung zu verbrauchen. Der Wortlaut sagt
 * stattdessen, dass sie mitgeteilt wird.
 */
function mandateBox(
  inputs: Inputs,
  creditor: { name: string; id: string } | undefined,
): string {
  if (!creditor) return '';
  const wording = mandateText({
    creditor: creditor.name,
    creditorId: creditor.id,
    mandateReference: null,
    accountHolder: inputs['accountHolder'] || inputs['name'] || '—',
    company: inputs['name'] || '—',
  });
  return [
    '<div class="sl-mandatee">',
    '<h3>Das Mandat im Wortlaut</h3>',
    `<pre>${escapeHtml(wording)}</pre>`,
    '</div>',
  ].join('');
}

/** Ein Eingabeschritt: Felder, Zurück-Knopf, Weiter-Knopf. */
export function stepPage(page: StepPage): string {
  const step = Steps.find((s) => s.number === page.step);
  if (!step) throw new Error(`Unbekannter Schritt: ${page.step}`);
  const error = page.error ?? [];
  const target = `/api/intake/${encodeURIComponent(page.token)}`;

  const total = stepsThisPath(page.inputs);
  const number = numberOnThisPath(step.number, page.inputs);

  return [
    pagesHeader(step.title),
    FORM_STYLE,
    '<main>',
    stepIndicator(number, total),
    `<p class="sl-step-count">Schritt ${number} von ${total}</p>`,
    // Der Organisationsname ist das EINZIGE, was vorbelegt erscheint — damit
    // erkennbar ist, dass der Link zur richtigen Stelle gehört.
    `<h1>${escapeHtml(page.companyName)}</h1>`,
    `<h2 style="font-size:1.05rem;margin:0 0 .75rem;">${escapeHtml(step.title)}</h2>`,
    `<p>${escapeHtml(step.introduction)}</p>`,
    error.length > 0
      ? [
          '<div class="sl-error-list">',
          `<p>${error.length === 1 ? 'Eine Angabe fehlt noch' : `${error.length} Angaben fehlen noch`}:</p>`,
          '<ul>',
          ...error.map((f) => `<li>${escapeHtml(f.message)}</li>`),
          '</ul>',
          '</div>',
        ].join('')
      : '',
    `<form method="post" action="${escapeHtml(target)}">`,
    hidden(page.inputs, step.fields),
    `<input type="hidden" name="_step" value="${step.number}">`,
    // Die Felder des Mandatsschritts, dann der Wortlaut, dann das Haeckchen:
    // Man liest, wozu man zustimmt, BEVOR die Zustimmung dasteht.
    ...step.fields
      .filter((field) => field.name !== 'mandate')
      .map((field) => fieldHtml(field, page.inputs, error)),
    step.fields.some((field) => field.name === 'mandate')
      ? mandateBox(page.inputs, page.creditor)
      : '',
    ...step.fields
      .filter((field) => field.name === 'mandate')
      .map((field) => fieldHtml(field, page.inputs, error)),
    '<div class="sl-button-row">',
    '<button type="submit" name="_target" value="next">Weiter</button>',
    step.number > 1
      ? '<button type="submit" name="_target" value="back" class="sl-secondary" formnovalidate>Zurück</button>'
      : '',
    '</div>',
    '</form>',
    '</main>',
    pagesFoot(),
  ].join('\n');
}

/** Eine Zeile der Prüfansicht. */
function checkRow(field: Field, inputs: Inputs): string {
  const raw = inputs[field.name] ?? '';
  if (raw === '') return '';
  const value =
    field.name === 'iban'
      ? maskIban(raw)
      : field.kind === 'select'
        ? (field.options?.find((o) => o.value === raw)?.text ?? raw)
        : field.kind === 'checkbox'
          ? 'ja'
          : raw;
  const label = field.label || 'Mandat erteilt';
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

/**
 * Die Prüfansicht: alles noch einmal lesen, dann absenden.
 *
 * JEDER ABSCHNITT HAT EINEN „Ändern"-KNOPF. Er ist ein `submit` mit dem Ziel
 * `step-N` und trägt den vollen Zustand zurück — nichts geht verloren, und
 * es braucht kein JavaScript dafür.
 */
export function checkPage(page: StepPage): string {
  const target = `/api/intake/${encodeURIComponent(page.token)}`;
  const paymentMethod = page.inputs['paymentMethod'];
  const error = page.error ?? [];

  return [
    pagesHeader('Bitte noch einmal lesen'),
    FORM_STYLE,
    '<main>',
    stepIndicator(
      numberOnThisPath(CheckStep, page.inputs),
      stepsThisPath(page.inputs),
    ),
    `<p class="sl-step-count">Schritt ${numberOnThisPath(CheckStep, page.inputs)} von ${stepsThisPath(page.inputs)}</p>`,
    `<h1>${escapeHtml(page.companyName)}</h1>`,
    '<p>Bitte lies alles noch einmal durch. Erst mit dem Absenden gehen die ' +
      'Angaben an uns.</p>',
    error.length > 0
      ? [
          '<div class="sl-error-list">',
          '<p>So lässt sich das noch nicht abschicken:</p>',
          '<ul>',
          ...error.map((f) => `<li>${escapeHtml(f.message)}</li>`),
          '</ul>',
          '</div>',
        ].join('')
      : '',
    `<form method="post" action="${escapeHtml(target)}">`,
    hidden(page.inputs, []),
    `<input type="hidden" name="_step" value="${CheckStep}">`,
    ...Steps.filter(
      (s) => s.number !== 5 || paymentMethod === 'direct_debit',
    ).map((s) =>
      [
        '<section class="sl-check">',
        `<h2>${escapeHtml(s.title)}</h2>`,
        '<dl>',
        // Ein Abschnitt ohne eine einzige Angabe zeigte sonst nur seine
        // Ueberschrift und einen Knopf — das sieht aus wie ein Fehler.
        // Freiwillige Abschnitte duerfen leer bleiben, aber sie sollen es
        // SAGEN.
        s.fields.every((field) => (page.inputs[field.name] ?? '') === '')
          ? '<dt>—</dt><dd>Nichts angegeben</dd>'
          : s.fields
              .map((field) => checkRow(field, page.inputs))
              .join(''),
        '</dl>',
        `<button type="submit" name="_target" value="step-${s.number}" class="sl-secondary" formnovalidate style="margin-top:.5rem;padding:.35rem .8rem;font-size:.85rem;">Ändern</button>`,
        '</section>',
      ].join(''),
    ),
    '<div class="sl-button-row">',
    // `formaction` auf die eigene Absenderoute: Sie hat ein engeres
    // Ratenlimit als das Blaettern. Das Formular selbst zeigt weiter auf die
    // Schrittroute, damit die „Aendern"-Knoepfe dort landen — ein Formular
    // hat nur ein `action`, aber jeder Knopf darf ein eigenes Ziel tragen.
    `<button type="submit" name="_target" value="submit" formaction="${escapeHtml(target)}/submit">Angaben absenden</button>`,
    '</div>',
    '</form>',
    '</main>',
    pagesFoot(),
  ].join('\n');
}

/** Die Seite nach dem Absenden. */
export function thanksPage(companyName: string): string {
  return [
    pagesHeader('Danke — eure Angaben sind bei uns'),
    '<main>',
    '<h1>Danke — eure Angaben sind bei uns.</h1>',
    `<p>Wir haben alles zu ${escapeHtml(companyName)} gespeichert und ` +
      'melden uns, sobald eure Instanz bereitsteht.</p>',
    '<p>Dieser Link ist damit verbraucht. Wenn ihr etwas ändern möchtet, ' +
      'antwortet einfach auf unsere Mail.</p>',
    '</main>',
    pagesFoot(),
  ].join('\n');
}

/**
 * Die Seite für einen Link, der nicht (mehr) gilt.
 *
 * EIN EINZIGER WORTLAUT für unbekannt, abgelaufen, eingelöst und
 * zurückgezogen — dieselbe Zurückhaltung wie bei der Einwilligung: Wer einen
 * fremden Token ausprobiert, soll nicht erfahren, ob er nie existierte oder
 * gerade abgelaufen ist.
 */
export function invalidPage(): string {
  return [
    pagesHeader('Dieser Link gilt nicht mehr'),
    '<main>',
    '<h1>Dieser Link gilt nicht mehr.</h1>',
    '<p>Aufnahmelinks gelten 14 Tage. Möglicherweise ist die Frist abgelaufen, ' +
      'oder die Angaben sind schon bei uns angekommen.</p>',
    '<p>Schreib uns kurz — wir schicken einen neuen.</p>',
    '</main>',
    pagesFoot(),
  ].join('\n');
}
