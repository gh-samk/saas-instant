import type { InstanceStatus } from '../lib/api';
import { instanceStatusStyle } from '../lib/instance-status';

/**
 * Statusabzeichen einer Instanz — dasselbe Rezept wie
 * `OrganisationStatusAbzeichen`, nur mit drehendem Icon für Übergänge.
 *
 * Farbe ist nie das alleinige Signal: Jedes Abzeichen trägt zusätzlich sein
 * Icon und sein ausgeschriebenes Label.
 */
export function InstanceStatusBadge({
  status,
  className,
}: {
  status: InstanceStatus;
  className?: string;
}) {
  const style = instanceStatusStyle(status);
  const Icon = style.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.surface} ${style.border} ${style.text} ${className ?? ''}`}
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${style.spinning ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {style.label}
    </span>
  );
}
