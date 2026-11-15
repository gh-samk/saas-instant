import type { CompanyStatus } from '../lib/api';
import { COMPANY_STATUS } from '../lib/company-status';

/**
 * Statusabzeichen einer Organisation — dasselbe Rezept wie `EintragAbzeichen`
 * aus `@saas-instant/ui`, nur mit der CRM-eigenen Quelle.
 *
 * Farbe ist nie das alleinige Signal: Jedes Abzeichen trägt zusätzlich sein
 * Icon und sein ausgeschriebenes Label.
 */
export function CompanyStatusBadge({
  status,
  className,
}: {
  status: CompanyStatus;
  className?: string;
}) {
  const style = COMPANY_STATUS[status];
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
