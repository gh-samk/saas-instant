import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { Card, Button, EmptyState, Skeleton } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { addNote, fetchHistory, type HistoryEntry } from '../lib/api';
import { HistoryRow } from './HistoryRow';
import { useT } from '../i18n';

/**
 * Der gemeinsame chronologische Verlauf einer Organisation.
 *
 * EINE LISTE, NICHT DREI. Notizen von Hand, Statuswechsel und der Wechsel der
 * Ansprechpartnerin stehen gemischt untereinander — sie sind serverseitig
 * dieselbe Datenart (`Notiz`, unterschieden nur durch `vomSystem`) und kommen
 * aus einer Abfrage. Was passiert ist, liest sich in der Reihenfolge, in der
 * es passiert ist, und nicht in drei Karten nebeneinander.
 *
 * NEUESTES ZUERST — anders als die Aufgabenliste des Dashboards, die die
 * älteste Fälligkeit oben zeigt. Beides folgt derselben Logik von
 * unterschiedlichen Enden der Zeitachse: Die Aufgabenliste beantwortet „was
 * tue ich als Nächstes", der Verlauf „was ist zuletzt passiert".
 *
 * Die Reihenfolge kommt vom Server (Tagesdatum absteigend, bei Gleichstand
 * der Schreibzeitpunkt). Sie hier noch einmal zu sortieren, hieße dieselbe
 * Regel zweimal zu pflegen.
 *
 * MAILS: Das Datenmodell kennt `MailVersand`, die API stellt ihn in dieser
 * Etappe aber nicht bereit und es wird auch keiner geschrieben. Sobald sie es
 * tut, reihen sich Mails hier ein, ohne dass sich am Aufbau etwas ändert —
 * eine zweite, getrennte Liste dafür anzulegen, wäre der Fehler, den diese
 * Karte gerade vermeidet.
 */
export function CompanyHistory({
  companyId,
  /** Zählt hoch, wenn andernorts etwas passiert ist (Statuswechsel …). */
  update,
}: {
  companyId: string;
  update: number;
}) {
  const t = useT();
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newNote, setNewNote] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { notes } = await fetchHistory(companyId);
      setHistory(notes);
    } catch (f) {
      setHistory(null);
      setLoadError(errorText(f, t('components.companyHistory.text')));
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load, update]);

  async function noteSave() {
    const text = newNote.trim();
    if (text === '') return;
    setNoteLoading(true);
    setNoteError(null);
    try {
      await addNote(companyId, text);
      setNewNote('');
      await load();
    } catch (f) {
      // Der Feldinhalt bleibt stehen — getippter Text geht nie verloren.
      setNoteError(errorText(f, t('components.companyHistory.text2')));
    } finally {
      setNoteLoading(false);
    }
  }

  return (
    <Card className="mt-6 p-6">
      <h2 className="mb-4 text-lg font-semibold text-text">{t('components.companyHistory.heading')}</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void noteSave();
        }}
        className="mb-6"
        noValidate
      >
        <label
          htmlFor="neue-notiz"
          className="mb-1 block text-sm font-medium text-text"
        >
          {t('components.companyHistory.label')}</label>
        <textarea
          id="neue-notiz"
          rows={3}
          value={newNote}
          disabled={noteLoading}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder={t('components.companyHistory.placeholder')}
          className="w-full rounded-lg border border-rahmen bg-flaeche px-3 py-2 text-sm text-text placeholder:text-leise focus:border-primaer focus:outline-none disabled:opacity-70"
        />
        {noteError && (
          <p role="alert" className="mt-1 text-sm text-gefahr">
            {noteError}
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            type="submit"
            loading={noteLoading}
            disabled={newNote.trim().length === 0}
          >
            {t('components.companyHistory.button')}</Button>
        </div>
      </form>

      {loadError ? (
        <>
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('components.companyHistory.button2')}</Button>
        </>
      ) : history === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : history.length === 0 ? (
        <EmptyState
          Icon={History}
          title={t('components.companyHistory.title')}
          notice={t('components.companyHistory.notice')}
        />
      ) : (
        <ul className="divide-y divide-rahmen">
          {history.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              onChanged={(changed) =>
                setHistory((alt) =>
                  alt === null
                    ? alt
                    : alt.map((e) => (e.id === changed.id ? changed : e)),
                )
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
