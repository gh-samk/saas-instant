import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileSearch, Info, Search } from 'lucide-react';
import { InputField, Card, Button, Spinner } from '@saas-instant/ui';
import { ConsentEvidence } from '../components/ConsentEvidence';
import { RecipientSelectCard } from '../components/RecipientSelectCard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { BroadcastTabs } from '../components/BroadcastTabs';
import { useBroadcastNumbers } from '../lib/broadcast-numbers';
import { errorText } from '../lib/api-client';
import { TEXT_BUTTON } from '../lib/styles';
import { fetchEvidence, type Evidence } from '../lib/api';
import { useT } from '../i18n';

/** Grobe Vorprüfung, damit ein Tippfehler nicht erst am Server auffällt. */
function isEmailFormal(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/** Was die Suche ergeben hat. `null` als Treffer heisst „kein Eintrag". */
type SearchState =
  | { kind: 'nothing' }
  | { kind: 'loading' }
  | { kind: 'hit'; email: string; evidence: Evidence | null }
  | { kind: 'error'; message: string };

/**
 * ===========================================================================
 * EINWILLIGUNGEN EINSEHEN — der Nachweis, wenn jemand fragt
 * ===========================================================================
 *
 * Der Nachweis ist der eigentliche Wert dieser ganzen Etappe. Gespeichert wird
 * nicht „hat zugestimmt", sondern WOZU: der Satz am Häkchen im Wortlaut, beide
 * Zeitpunkte, beide IP-Adressen. Wenn jemand fragt — eine Person, eine
 * Aufsichtsbehörde, ein Anwalt —, ist das die Antwort. Sie muss sich finden
 * lassen, ohne dass jemand in die Datenbank sieht.
 *
 * DIE SUCHE GEHT NUR ÜBER DIE GANZE ADRESSE, und das ist keine Bequemlichkeit,
 * die fehlt: `GET /api/broadcast/nachweis` nimmt genau eine Adresse und
 * antwortet mit einer Zeile oder mit `null`. Es gibt keine Route, die nach
 * Namensteilen sucht oder alle Einträge auflistet — eine solche Liste wäre
 * genau das Adressverzeichnis, gegen das der Rest dieser Etappe gebaut ist.
 *
 * DIE EINZIGE LISTE, DIE ES GIBT, sind die Adressen mit BESTÄTIGTER
 * Einwilligung. Sie ist die Empfängerauswahl und damit eine betriebliche
 * Notwendigkeit — nicht dasselbe wie ein Verzeichnis aller je eingetragenen
 * Adressen samt Sperreinträgen.
 *
 * NICHTS AUF DIESER SEITE ÄNDERT ETWAS. Es gibt keinen Knopf, der einen
 * Zustand setzt; die einzige Änderung, die von Hand möglich ist, ist die
 * Sperre, und die hat ihre eigene Seite mit ihrer eigenen Warnung.
 */
export function ConsentsPage() {
  const t = useT();
  const [input, setInput] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'nothing' });
  const [inputError, setInputError] = useState<string>();
  const { numbers } = useBroadcastNumbers();
  // Die Zahl kommt aus der Empfängerabfrage, nicht aus dem Reiterzähler:
  // Sie steht direkt über der Tabelle und muss zu ihr passen.
  const [count, setCount] = useState<number | null>(null);

  async function search() {
    const address = input.trim();
    if (!isEmailFormal(address)) {
      setInputError(t('einwilligungen.emailRequired'));
      return;
    }
    setInputError(undefined);
    setState({ kind: 'loading' });
    try {
      const evidence = await fetchEvidence(address);
      setState({ kind: 'hit', email: address, evidence });
    } catch (f) {
      setState({
        kind: 'error',
        message: errorText(f, t('einwilligungen.evidenceLoadError')),
      });
    }
  }

  return (
    <section aria-labelledby="consents-title">
      <h1
        id="consents-title"
        className="mb-1 text-2xl font-semibold tracking-tight text-text"
      >
        {t('einwilligungen.title')}</h1>
      <BroadcastTabs numbers={numbers} />

      {/* SUCHE LINKS, ZAHL RECHTS. Die Zahl kommt aus DERSELBEN Abfrage wie
          die Tabelle darunter (`onGeladen`) — zwei eigene Abfragen liefen
          auseinander, und ausgerechnet die Zahl über der Liste wäre dann die
          ältere. */}
      {/* Bei 0 Adressen steht die Zahl nicht groß über dem Leerzustand: Der
          sagt dasselbe in Worten, und eine große „0" wäre nur Lärm. */}
      <div
        className={`mb-5 grid gap-4 ${
          count === 0 ? '' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]'
        }`}
      >
      <ErrorBoundary area={t('einwilligungen.evidenceSearchArea')}>
        <Card className="h-full p-[18px]">
          <div className="mb-1 flex items-center gap-2">
            <FileSearch className="h-5 w-5 shrink-0 text-leise" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-text">
              {t('einwilligungen.evidenceHeading')}</h2>
          </div>
          <p className="mb-4 text-sm text-leise">
            {t('einwilligungen.evidenceIntro')}</p>

          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void search();
            }}
            noValidate
          >
            <InputField
              id="nachweis-email"
              name="nachweis-email"
              label={t('einwilligungen.emailLabel')}
              type="email"
              autoComplete="off"
              inputMode="email"
              value={input}
              onChange={(ev) => {
                setInput(ev.target.value);
                setInputError(undefined);
              }}
              error={inputError}
            />
            <Button
              type="submit"
              loading={state.kind === 'loading'}
              disabled={!isEmailFormal(input.trim())}
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              {t('einwilligungen.evidenceSearchButton')}</Button>
          </form>

          <div aria-live="polite">
            {state.kind === 'loading' && <Spinner text={t('einwilligungen.evidenceLoading')} />}

            {state.kind === 'error' && (
              <p role="alert" className="mt-4 text-sm text-gefahr">
                {state.message}
              </p>
            )}

            {state.kind === 'hit' && state.evidence === null && (
              <div className="mt-4 rounded-lg border border-rahmen bg-flaeche-2 p-3">
                <p className="text-sm font-medium text-text">
                  {t('einwilligungen.noEntryPrefix')}<span className="break-all">{state.email}</span> {t('einwilligungen.noEntrySuffix')}</p>
                <p className="mt-1 text-sm text-leise">
                  {t('einwilligungen.noEntryExplanation')}</p>
                <p className="mt-1 text-sm text-leise">
                  {t('einwilligungen.objectionHint')}{' '}
                  <Link to="/broadcast/blocklist" className={TEXT_BUTTON}>
                    {t('einwilligungen.blockAddress')}</Link>
                  .
                </p>
              </div>
            )}

            {state.kind === 'hit' && state.evidence !== null && (
              <div className="mt-6 border-t border-rahmen pt-4">
                <ConsentEvidence evidence={state.evidence} />
              </div>
            )}
          </div>
        </Card>
      </ErrorBoundary>

        {count !== 0 && (
        <Card className="h-full p-[18px]">
          <p className="ziffern-tabellarisch text-3xl font-semibold leading-none text-text">
            {count ?? '—'}
          </p>
          <p className="mt-1.5 text-sm text-leise">
            {t('einwilligungen.confirmedAddressesLabel')}</p>
          <p className="mt-3 flex items-start gap-2 text-sm text-still">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('einwilligungen.forecastHint')}</p>
        </Card>
        )}
      </div>

      <ErrorBoundary area={t('einwilligungen.recipientListArea')}>
        <RecipientSelectCard
          className="mb-5"
          title={t('einwilligungen.recipientListTitle')}
          asTable
          withoutMetric
          onLoaded={(selection) => setCount(selection.count)}
        />
      </ErrorBoundary>

      <Card className="p-4">
        <p className="text-sm text-leise">
          {t('einwilligungen.revocationNoticeStart')}{' '}
          <Link to="/broadcast/blocklist" className={TEXT_BUTTON}>
            {t('einwilligungen.blocklistLink')}</Link>{' '}
          {t('einwilligungen.revocationNoticeEnd')}</p>
      </Card>
    </section>
  );
}
