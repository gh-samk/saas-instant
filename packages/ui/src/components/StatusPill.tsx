/**
 * Der Status als Pille — nie als Satz.
 *
 * DIE REGEL DAHINTER: Gleiche Farbe bedeutet überall dasselbe. `Aktiv`,
 * `Erledigt` und „läuft" sind grün, weil alle drei heissen „in Ordnung,
 * nichts zu tun". `Ruhend`, „offen" und „im Aufbau" sind bernstein, weil
 * alle drei heissen „braucht einen Blick".
 * Wer diese Zuordnung an einer Stelle bricht, macht sie überall wertlos.
 *
 * DAS WORT STEHT IMMER DA. Farbe ist nie das alleinige Signal — nicht nur
 * wegen Farbfehlsichtigkeit, sondern weil ein grüner Punkt ohne Wort auch
 * für Sehende raten heisst. Der Punkt ist Zugabe, nicht Ersatz.
 *
 * `zusatz` ist für den Fall, dass ein Status eine Unterlage hat, die man
 * nicht verlieren will: „Testphase" mit „läuft" darunter. Zwei getrennte Pillen
 * wären zwei Aussagen, wo es eine ist.
 */

export type StatusKind = 'neutral' | 'notice' | 'attention' | 'problem' | 'confirmed';

const STYLES: Record<StatusKind, string> = {
  neutral: 'bg-flaeche-3 border-rahmen text-leise',
  notice: 'bg-vorschlag-bg border-vorschlag-rahmen-hell text-vorschlag-text',
  attention: 'bg-bedenken-bg border-bedenken-rahmen-hell text-bedenken-text',
  problem: 'bg-einwand-bg border-einwand-rahmen-hell text-einwand-text',
  confirmed: 'bg-beschluss-bg border-beschluss-rahmen-hell text-beschluss-text',
};

const POINTS: Record<StatusKind, string> = {
  neutral: 'bg-inaktiv',
  notice: 'bg-vorschlag-rahmen',
  attention: 'bg-bedenken-rahmen',
  problem: 'bg-einwand-rahmen',
  confirmed: 'bg-beschluss-rahmen',
};

export function StatusPill({
  kind,
  children,
  extra,
  withPoint = false,
  className,
}: {
  kind: StatusKind;
  /** Das Wort. Ohne das Wort keine Pille. */
  children: string;
  /** Zweite Zeile für eine Unterlage („Testphase" / „läuft"). */
  extra?: string;
  withPoint?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12.5px] font-semibold leading-tight ${STYLES[kind]} ${className ?? ''}`}
    >
      {withPoint && (
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${POINTS[kind]}`}
          aria-hidden="true"
        />
      )}
      <span>
        {children}
        {extra !== undefined && (
          <span className="block text-[11px] font-medium opacity-80">{extra}</span>
        )}
      </span>
    </span>
  );
}
