import { consentStatusStyle } from '../lib/consent-status';

/**
 * Statusabzeichen einer Einwilligung — dasselbe Rezept wie
 * `RechnungStatusAbzeichen` und `OrganisationStatusAbzeichen`.
 *
 * Farbe ist nie das alleinige Signal: Jedes Abzeichen trägt zusätzlich Icon
 * und ausgeschriebenes Label.
 */
export function ConsentStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const style = consentStatusStyle(status);
  const Icon = style.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.surface} ${style.border} ${style.text} ${className ?? ''}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {style.label}
    </span>
  );
}
