import type { PasswordStrength } from '../lib/password-strength';
import { t } from '../i18n';

const LABEL: Record<1 | 2 | 3, string> = {
  1: t('components.passwordStrengthIndicator.item1'),
  2: t('components.passwordStrengthIndicator.item2'),
  3: t('components.passwordStrengthIndicator.item3'),
};

/**
 * Stufenanzeige der Passwortstärke.
 *
 * Bewusst nur EINE Farbe (`bg-primaer`) über alle drei Stufen, dafür immer
 * ein Text daneben: eine Ampel (rot/gelb/grün) bräuchte entweder einen neuen
 * Farbwert oder würde die vier Eintragsfarben fachfremd umdeuten — beides
 * verbietet R7. Die Textstufe macht die Anzeige zugleich unabhängig von
 * Farbwahrnehmung.
 */
export function PasswordStrengthIndicator({ strength }: { strength: PasswordStrength }) {
  // Ein leeres Feld verdient keine Bewertung.
  if (strength === 0) return null;

  return (
    <div className="mt-1.5 mb-3 flex items-center gap-2">
      <div className="flex flex-1 gap-1" role="presentation">
        {[1, 2, 3].map((tier) => (
          <span
            key={tier}
            className={`h-1.5 flex-1 rounded-full ${
              tier <= strength ? 'bg-primaer' : 'bg-flaeche-3'
            }`}
            aria-hidden="true"
          />
        ))}
      </div>
      <span className="text-xs font-medium text-leise">{LABEL[strength]}</span>
    </div>
  );
}
