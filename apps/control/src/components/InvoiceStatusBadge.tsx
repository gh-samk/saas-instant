import type { PaymentState } from '../lib/api';
import { paymentStateStyle } from '../lib/invoice-status';

/**
 * Statusabzeichen einer Rechnung — dasselbe Rezept wie
 * `OrganisationStatusAbzeichen` und `InstanzStatusAbzeichen`.
 *
 * Es nimmt AUSSCHLIESSLICH `zahlungsstand` entgegen, nie `status`. Die Prop
 * heißt deshalb auch so: Wer versehentlich die rohe Datenbankspalte übergibt,
 * bekommt einen Typfehler statt eines zweiten, konkurrierenden Abzeichens.
 *
 * Farbe ist nie das alleinige Signal: Jedes Abzeichen trägt zusätzlich Icon
 * und ausgeschriebenes Label.
 */
export function InvoiceStatusBadge({
  paymentState,
  className,
}: {
  paymentState: PaymentState;
  className?: string;
}) {
  const style = paymentStateStyle(paymentState);
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
