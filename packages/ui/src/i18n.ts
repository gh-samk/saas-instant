/**
 * Texte des Design-Systems.
 *
 * Die Komponenten enthalten keine deutschen Literale: Sichtbare Texte stehen
 * hier im Wörterbuch (`uiTexts`, Schlüssel englisch, Werte deutsch) und werden
 * über `uiT()` gelesen. Die Anwendung bindet ihre eigene i18n-Schicht per
 * `configureUiTexts()` ein (siehe `apps/control/src/browser.tsx`); ohne diese
 * Bindung liefert `uiT()` den deutschen Standardtext, damit das Paket auch
 * allein (Tests, Storybook) vollständig lesbar bleibt.
 */
export const uiTexts = {
  'dialog.close': 'Schließen',
  'toast.close': 'Schließen',
  'toast.outsideProvider': 'useToast muss innerhalb von <ToastProvider> genutzt werden.',
  'loadingIndicator.text': 'Lädt …',
  'entryColors.suggestion': 'Vorschlag',
  'entryColors.concern': 'Bedenken',
  'entryColors.objection': 'Einwand',
  'entryColors.decision': 'Beschluss',
} as const;

export type UiTextKey = keyof typeof uiTexts;
export type UiTextParams = Record<string, string | number>;
export type UiTranslator = (key: string, params?: UiTextParams) => string;

let translator: UiTranslator | null = null;

/** Bindet die Übersetzung der Anwendung ein (Schlüssel mit Präfix `ui.`). */
export function configureUiTexts(fn: UiTranslator | null): void {
  translator = fn;
}

export function uiT(key: UiTextKey, params?: UiTextParams): string {
  if (translator) {
    const translated = translator(`ui.${key}`, params);
    if (translated !== `ui.${key}`) return translated;
  }
  const text: string = uiTexts[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
