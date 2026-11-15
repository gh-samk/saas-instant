import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { ROW_LINK_CLASSES, useToast } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { checkOutbox, type Action } from '../lib/api';
import { useT } from '../i18n';

/**
 * Sieht aus wie `Knopf variante="sekundaer"`, ist aber ein Link.
 *
 * Die Klassen sind kopiert und nicht die Komponente wiederverwendet: `Knopf`
 * rendert immer ein `<button>`, und ein Navigationsziel gehört semantisch in
 * ein `<a>` — mit Mittelklick, „in neuem Tab öffnen" und allem, was
 * Nutzende von einem Link erwarten.
 */
/**
 * SEIT DEM REDESIGN EIN TEXTLINK, KEIN KNOPF.
 *
 * In einer Liste mit neun Zeilen stuenden neun umrandete Knoepfe
 * untereinander, und das Auge findet die Zeile nicht mehr, auf die es
 * ankommt. Der Textlink ordnet sich unter und bleibt trotzdem der
 * offensichtliche naechste Schritt — eine ausdrueckliche Festlegung des
 * Entwurfs.
 */

/**
 * Die benannte Handlung einer Dashboard-Aufgabe.
 *
 * Das Backend liefert zu jeder Aufgabe eine Handlung mit eigener Bezeichnung
 * („Anfrage bearbeiten", „Überprüfung vorbereiten", „Änderung ansehen",
 * „Löschung prüfen") und ein Ziel innerhalb der Anwendung. Die Oberfläche
 * muss die Aufgabenart dafür nicht kennen — deshalb steht hier auch keine
 * Verzweigung nach Art.
 *
 * ES GIBT KEIN „ABHAKEN". Aufgaben werden bei jeder Abfrage neu aus dem
 * Datenbestand abgeleitet und nirgends gespeichert; es existiert bewusst kein
 * Endpunkt, der eine Aufgabe als erledigt markiert. Eine Aufgabe verschwindet,
 * wenn der Grund verschwindet — etwa, sobald eine eigene Notiz an der
 * Organisation steht. Ein Häkchen, das nur so täte, wäre eine Lüge.
 *
 * Fremde Ziele werden nicht verlinkt: `ziel` kommt zwar aus dem eigenen
 * Backend, aber ein Wert, der nicht mit „/" beginnt, ist keine Route dieser
 * Anwendung und wird deshalb gar nicht erst angeboten.
 */
export function TaskAction({
  action,
  afterAction,
}: {
  action: Action;
  /** Wird nach einer Handlung gerufen, die keine Seite wechselt. */
  afterAction?: () => void;
}) {
  if (action.kind === 'outbox_check') {
    return <OutboxCheck label={action.label} afterAction={afterAction} />;
  }
  if (!action.target.startsWith('/')) {
    return <span className="text-sm text-leise">{action.label}</span>;
  }
  return (
    <Link
      to={`${action.target}${TARGET_TAB[action.kind] ?? ''}`}
      // `text-right` und Umbruch erlaubt: Eine lange Beschriftung soll
      // die Spalte nicht sprengen, sondern zweizeilig werden.
      className={`${ROW_LINK_CLASSES} justify-end text-right`}
    >
      {action.label}
      <ArrowRight className="h-[15px] w-[15px]" aria-hidden="true" />
    </Link>
  );
}

/**
 * Die EINE Stelle, an der die Art der Handlung doch eine Rolle spielt.
 *
 * Der Server kann in `ziel` nur eine Seite benennen, keinen Abschnitt darin.
 * „Löschung prüfen" führt aber nicht irgendwohin auf die Detailseite, sondern
 * genau zu dem Vorgang, der den Vorschlag einlöst — sonst bliebe die Aufgabe
 * eine Zusage, die niemand findet.
 *
 * WARUM REITER UND NICHT MEHR SPRUNGMARKEN. Bis zum Redesign standen hier
 * `#kontaktdaten-loeschen` und `#rechnungen`. Auf einer langen Scrollseite
 * war das richtig; seit die Detailseite sechs Reiter hat, ist es falsch: Der
 * Abschnitt ist gar nicht gerendert, solange sein Reiter zu ist, und der
 * Browser springt ins Leere. Genau das ist beim Umbau entstanden und hier
 * behoben.
 *
 * Den unumkehrbaren Dialog öffnet weiterhin nur ein bewusster Klick — ein
 * Reiter zeigt, er löst nichts aus.
 */
const TARGET_TAB: Partial<Record<Action['kind'], string>> = {
  deletion_check: '?tab=privacy',
  invoice_create: '?tab=invoices',
  // `zahlung_pruefen` steht NICHT hier: Ihr Ziel ist eine einzelne Rechnung
  // (`/companies/:id/invoices/:invoiceId`), keine Detailseite mit
  // Reitern. Ein `?tab=` daran waere ein Parameter, den niemand liest.
  // Der Ort, an dem sowohl eine fehlende Preisangabe als auch eine zu
  // niedrige Stufe entschieden wird.
  price_agree: '?tab=contract',
};

/**
 * DIE EINZIGE HANDLUNG, DIE EIN KNOPF IST (12.09.2026).
 *
 * Ein gestörter Postausgang hat keinen Ort in der Anwendung, zu dem ein Link
 * führen könnte — behoben wird er in Coolify oder am Mailserver. Was man
 * danach hier braucht, ist die Bestätigung: Die Probe meldet sich am
 * Mailserver an (keine Mail), und die Aufgabenliste wird neu geladen. Ohne
 * den Knopf stünde die Aufgabe bis zur nächsten stündlichen Probe weiter da,
 * obwohl der Grund längst weg ist.
 *
 * Verzweigt wird nach der Art der HANDLUNG, nicht der Aufgabe — wie bei
 * `ZIELREITER`. Es bleibt dabei: Es gibt kein „Abhaken". Der Knopf ändert
 * nichts am Bestand, er prüft nur neu.
 */
function OutboxCheck({
  label,
  afterAction,
}: {
  label: string;
  afterAction?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [running, setRunning] = useState(false);

  async function check() {
    setRunning(true);
    try {
      const situation = await checkOutbox();
      const gestoert = situation.some(
        (l) => l.state === 'gestoert' || l.state === 'nicht_eingerichtet',
      );
      toast.show(
        gestoert
          ? t('components.taskAction.text')
          : t('components.taskAction.text2'),
      );
      afterAction?.();
    } catch (error) {
      toast.show(errorText(error, t('components.taskAction.text3')));
    } finally {
      setRunning(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void check()}
      disabled={running}
      aria-busy={running}
      className={`${ROW_LINK_CLASSES} justify-end text-right disabled:opacity-60`}
    >
      {running ? t('components.taskAction.button') : label}
      <RefreshCw
        className={`h-[15px] w-[15px] ${running ? 'motion-safe:animate-spin' : ''}`}
        aria-hidden="true"
      />
    </button>
  );
}
