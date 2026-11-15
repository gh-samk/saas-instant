import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';
import { Card, Button } from '@saas-instant/ui';
import { t } from '../i18n';

/**
 * ===========================================================================
 * EIN FEHLER IN EINER KARTE DARF NICHT DIE SEITE AUSLÖSCHEN
 * ===========================================================================
 *
 * Am 2026-08-31 stürzte jede Organisationsseite ohne Instanz auf eine
 * vollständig weiße Fläche ab — kein Kopf, keine Navigation, nichts. Die
 * Ursache war ein einziger Lesezugriff auf `instanz.subdomain`, weil ein
 * leerer Antwortkörper zu `undefined` statt zu `null` geworden war. Diese
 * Ursache ist behoben (`api-client.ts`, `InstanzKarte.tsx`), aber sie ist
 * nicht der Befund. Der Befund ist, dass ein einzelner Lesefehler alles
 * mitreißen konnte.
 *
 * React hat dafür genau ein Mittel, und es geht nur als Klasse: eine
 * Fehlergrenze. Sie fängt Fehler beim Rendern der Kinder ab und ersetzt NUR
 * diesen Ausschnitt.
 *
 * ZWEI EBENEN, BEIDE NÖTIG:
 *
 * 1. Um jede eigenständig ladende Karte (`variante="karte"`). Fällt die
 *    Instanz-Karte, bleiben Stammdaten, Rechnungen und Verlauf bedienbar —
 *    und damit der Weg zur Rechnungsverwaltung offen.
 * 2. Um den Seiteninhalt im `AppShell` (`variante="bereich"`). Was auch immer
 *    eine Seite zerlegt: Kopfleiste und Navigation bleiben stehen, es gibt
 *    also immer einen Weg weg von der kaputten Stelle. Genau das fehlte.
 *
 * WAS SIE NICHT KANN, und das steht hier, damit es niemand annimmt: Fehler in
 * Ereignisbehandlern, in `setTimeout` und in abgelehnten Promises erreichen
 * eine Fehlergrenze NICHT. Dafür bleibt die Fehlerbehandlung an Ort und
 * Stelle zuständig — die Fehlergrenze ist das Netz darunter, nicht der Ersatz.
 *
 * KEIN STILLES SCHLUCKEN. Der Fehler geht in jedem Fall mit `console.error`
 * hinaus; sichtbar bleibt eine Meldung, die sagt, WELCHER Teil ausgefallen
 * ist, und ein Knopf, der ihn neu aufbaut.
 */

interface Props {
  /**
   * Wie der ausgefallene Teil heißt — er steht in der Meldung. „Etwas ist
   * schiefgelaufen" ohne Angabe, was, ist auf einer Seite mit sechs Karten
   * keine Auskunft.
   */
  area: string;
  /** `karte` sitzt in der Seite, `bereich` ersetzt den ganzen Seiteninhalt. */
  variant?: 'card' | 'area';
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Hochgezählt beim Neuaufbau — setzt die Kinder über `key` zurück. */
  round: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, round: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kein Silent Failure: Der Fehler steht mit Komponentenpfad in der
    // Konsole, auch wenn die Oberfläche ihn nicht im Wortlaut zeigt.
    console.error(
      `[Fehlergrenze] ${this.props.area}`,
      error,
      info.componentStack,
    );
  }

  private newBuild = (): void => {
    this.setState((z) => ({ error: null, round: z.round + 1 }));
  };

  render(): ReactNode {
    const { area, variant = 'card', children } = this.props;
    const { error, round } = this.state;

    if (error === null) {
      // Der `key` ist der eigentliche Rücksetzmechanismus: Er wirft den alten
      // Teilbaum weg, statt ihn mit seinem kaputten Zustand weiterzuverwenden.
      // Als `Fragment`, nicht als `div`: Die Grenze darf das Layout der Seite
      // nicht verändern — sie soll unsichtbar sein, solange nichts brennt.
      return <Fragment key={round}>{children}</Fragment>;
    }

    const content = (
      <>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-flaeche-3 text-gefahr">
            <AlertOctagon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p role="alert" className="text-sm font-medium text-text">
              {area} {t('components.errorBoundary.text')}</p>
            <p className="mt-1 text-sm text-leise">
              {variant === 'card'
                ? t('components.errorBoundary.text2')
                : t('components.errorBoundary.text3')}
            </p>
          </div>
        </div>
        <Button variant="secondary" className="mt-4" onClick={this.newBuild}>
          {t('components.errorBoundary.button')}</Button>
      </>
    );

    // `bereich` steht am Seitenanfang und braucht keinen Abstand nach oben;
    // eine Karte steht zwischen anderen und behält deren Rhythmus.
    return (
      <Card className={variant === 'area' ? 'p-6' : 'mt-6 p-6'}>
        {content}
      </Card>
    );
  }
}
