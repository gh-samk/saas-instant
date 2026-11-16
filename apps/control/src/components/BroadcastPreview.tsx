import { useState } from 'react';
import type { MailChannel, Preview } from '../lib/api';
import { TEXT_BUTTON } from '../lib/styles';
import { useT } from '../i18n';

/**
 * ===========================================================================
 * DIE VORSCHAU — das ganze Dokument, nicht der Rumpf
 * ===========================================================================
 *
 * `GET /vorlagen/:id/vorschau` liefert seit der Rahmenerweiterung nicht mehr
 * nur den Rumpf, sondern das VOLLSTÄNDIGE Dokument in beiden Fassungen
 * (`html`, `text`) — Kopf, Rumpf mit erkennbaren Beispielwerten und die
 * kanalgerechte Fusszeile. Gebaut wird es serverseitig über denselben Weg wie
 * beim Versand.
 *
 * DESHALB BAUT DIE OBERFLÄCHE HIER NICHTS MEHR NACH. Vorher stand an dieser
 * Stelle ein Rahmen, der BESCHRIEB, was der Server anhängt — Abmeldelink,
 * Anbieterkennung nach § 5 DDG und § 125a HGB, der Satz über die Einwilligung.
 * Diese Beschreibung war die richtige Antwort auf eine Antwort ohne Fusszeile,
 * aber sie war eine zweite Fassung einer Pflichtangabe: Sie hätte der Quelle
 * irgendwann davonlaufen können, und niemandem wäre es aufgefallen. Eine
 * Quelle, ein Wortlaut.
 *
 * DER ABMELDELINK IST EIN PLATZHALTER. Der Server setzt für die Vorschau
 * `https://…/api/einwilligung/abmeldung/beispiel-token` ein und liest keinen
 * Abmeldetoken aus der Datenbank. Ein gültiger Token einer echten Empfängerin
 * in einer Vorschau wäre eine Abmeldung auf Zuruf — deshalb steht die
 * eingesetzte Adresse zusätzlich unten bei den Beispielwerten, wo man sie als
 * Beispiel erkennt.
 *
 * `sandbox=""` OHNE JEDES RECHT — kein `allow-scripts`, kein
 * `allow-same-origin`, kein `allow-forms`. Das Dokument stammt aus dem eigenen
 * Backend und ist dort gesäubert; trotzdem wird es hier so behandelt, als wäre
 * es das nicht. `srcDoc` in einem rechtlosen Rahmen ist der Weg, serverseitig
 * erzeugtes HTML anzuzeigen, ohne `dangerouslySetInnerHTML` und ohne dass ein
 * künftiger Fehler in der Säuberung in dieser Anwendung etwas ausführen
 * könnte.
 *
 * DIE NUR-TEXT-ANSICHT ZEIGT `text`, NICHT `rumpf`. Beide Teile gehen
 * hinaus (`multipart/alternative`), und manche Postfächer zeigen
 * ausschliesslich den Textteil — der trägt die Fusszeile ebenfalls. Stünde
 * hier `rumpf`, behauptete die Ansicht wieder eine Mail ohne Anbieterkennung.
 * Sie ist ausserdem der barrierefreiere Weg, den Wortlaut zu prüfen: Text auf
 * der Seite statt Text in einem eingebetteten Dokument.
 */
export function BroadcastPreview({
  preview,
  channel,
}: {
  preview: Preview;
  channel: MailChannel;
}) {
  const t = useT();
  const [onlyTextOpen, setOnlyTextOpen] = useState(false);
  const used = Object.entries(preview.used);

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-rahmen">
        <div className="border-b border-rahmen bg-flaeche-3 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-leise">{t('components.broadcastPreview.text')}</p>
          <p className="mt-0.5 break-words text-sm font-semibold text-text">
            {preview.subject}
          </p>
        </div>

        <iframe
          title={t('components.broadcastPreview.title')}
          srcDoc={preview.html}
          sandbox=""
          className="block h-[520px] w-full border-0 bg-flaeche-2"
        />
      </div>

      <p className="mt-2 text-sm text-leise">
        {channel === 'marketing'
          ? t('components.broadcastPreview.text2') +
            t('components.broadcastPreview.text3') +
            t('components.broadcastPreview.text4') +
            t('components.broadcastPreview.text5')
          : t('components.broadcastPreview.text6') +
            t('components.broadcastPreview.text7')}
      </p>

      <button
        type="button"
        onClick={() => setOnlyTextOpen(!onlyTextOpen)}
        className={`mt-3 text-sm ${TEXT_BUTTON}`}
        aria-expanded={onlyTextOpen}
      >
        {onlyTextOpen
          ? t('components.broadcastPreview.button')
          : t('components.broadcastPreview.button2')}
      </button>
      {onlyTextOpen && (
        <div className="mt-2 rounded-lg border border-rahmen bg-flaeche px-4 py-3">
          <p className="mb-2 text-sm text-leise">
            {t('components.broadcastPreview.text8')}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-text">
            {preview.text}
          </pre>
        </div>
      )}

      {used.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-leise">
            {t('components.broadcastPreview.text9')}</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {used.map(([name, value]) => (
              <div key={name} className="flex min-w-0 flex-wrap gap-x-2">
                <dt className="font-mono text-xs text-leise">{`{{${name}}}`}</dt>
                <dd className="min-w-0 break-all text-sm text-text">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-sm text-leise">
            {t('components.broadcastPreview.text10')}</p>
        </div>
      )}
    </div>
  );
}
