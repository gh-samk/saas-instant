import { Megaphone, ReceiptEuro } from 'lucide-react';
import type { MailChannel } from '../lib/api';
import { CHANNEL_TEXTS } from '../lib/consent-status';

/**
 * Der Kanal einer Vorlage — sichtbar an jeder Stelle, an der eine Vorlage
 * auftaucht.
 *
 * Er ist die folgenreichste Eigenschaft einer Vorlage und die einzige, die
 * sich nach dem Anlegen NICHT mehr ändern lässt. Deshalb steht er nicht nur im
 * Formular, sondern an jeder Zeile: Wer zwei Vorlagen nebeneinander sieht,
 * soll ohne Klick erkennen, welche davon an Einwilligungen geht.
 *
 * Die beiden Farbfamilien sind bewusst NICHT rot/grün: Kein Kanal ist ein
 * Fehler. Werblich bekommt die Vorschlagsfamilie (blau), Transaktion die
 * neutrale Graukombination — dieselbe Zurückhaltung wie bei „Storniert".
 */
export function MailChannelBadge({
  channel,
  className,
}: {
  channel: MailChannel;
  className?: string;
}) {
  const marketing = channel === 'marketing';
  const Icon = marketing ? Megaphone : ReceiptEuro;
  const colors = marketing
    ? 'bg-vorschlag-bg border-vorschlag-rahmen text-vorschlag-text'
    : 'bg-flaeche-3 border-rahmen text-leise';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${colors} ${className ?? ''}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {CHANNEL_TEXTS[channel].label}
    </span>
  );
}
