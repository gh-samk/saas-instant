import type { TemplateDraft } from '../components/TemplateFields';
import type { MailChannel } from '../lib/api';

/**
 * Die vier Strukturfelder aus dem Entwurf, so wie der Server sie erwartet.
 *
 * ZWEI ENTSCHEIDUNGEN STECKEN DARIN:
 *
 * 1. BEIM TRANSAKTIONSKANAL WERDEN SIE GAR NICHT GESCHICKT. Das Formular
 *    zeigt sie dort nicht, der Rahmen kennt sie dort nicht — sie mitzusenden
 *    schriebe leere Spalten, die niemand angelegt hat.
 * 2. EIN LEERES FELD WIRD ALS LEERER TEXT GESCHICKT, nicht weggelassen. Der
 *    Server macht daraus `null` und löscht damit den alten Wert. Liesse man
 *    es weg, bliebe eine einmal gesetzte Überschrift für immer stehen.
 *
 * DER HALBE KNOPF WIRD NICHT ABGEFANGEN. Das tut das Formular
 * (`knopfBeanstandung`), bevor es überhaupt so weit kommt; hier noch einmal
 * zu prüfen hiesse, dieselbe Regel an zwei Orten zu pflegen.
 */
export function structureFields(
  channel: MailChannel,
  draft: Pick<
    TemplateDraft,
    'eyebrow' | 'heading' | 'buttonText' | 'buttonTarget'
  >,
): {
  eyebrow?: string;
  heading?: string;
  buttonText?: string;
  buttonTarget?: string;
} {
  if (channel !== 'marketing') return {};
  return {
    eyebrow: draft.eyebrow.trim(),
    heading: draft.heading.trim(),
    buttonText: draft.buttonText.trim(),
    buttonTarget: draft.buttonTarget.trim(),
  };
}
