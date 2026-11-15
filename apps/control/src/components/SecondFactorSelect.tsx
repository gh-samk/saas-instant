import { Fingerprint, KeyRound, Mail, type LucideIcon } from 'lucide-react';
import { Badge } from '@saas-instant/ui';
import { useT } from '../i18n';

/** Die drei Wege, mit denen sich jemand zusätzlich zum Passwort bestätigt. */
export type SecondFactorMethod = 'email' | 'totp' | 'passkey';

interface Props {
  value: SecondFactorMethod | null;
  onValueChange: (value: SecondFactorMethod) => void;
  /** Blendet die Passkey-Karte aus, wenn der Browser keine Passkeys kennt. */
  passkeyAvailable: boolean;
}

/**
 * Drei gleichrangige, gleich große Auswahlkarten für den zweiten Faktor.
 * Rein darstellend — kein WebAuthn, kein Netzwerk, kein eigener „Weiter"-Knopf:
 * Der Klick auf eine Karte IST die Handlung, der Aufrufer schaltet daraufhin
 * selbst auf den passenden Unterweg um.
 *
 * `role="radiogroup"`/`role="radio"` statt dreier beliebiger Knöpfe, damit
 * Sprachausgaben „1 von 3 ausgewählt" ansagen und nicht drei ungruppierte
 * Aktionen. Die Karten stapeln auf allen Breiten (auch bei 1440 px):
 * nebeneinander wären sie in der `max-w-xl`-Wizardspalte zu schmal für Titel
 * und Beschreibung ohne Umbruch.
 */
export function SecondFactorSelect({
  value,
  onValueChange,
  passkeyAvailable,
}: Props) {
  const t = useT();
  return (
    <div
      role="radiogroup"
      aria-label={t('components.secondFactorSelect.ariaLabel')}
      className="flex flex-col gap-3"
    >
      <SelectCard
        Icon={Mail}
        title={t('components.secondFactorSelect.title')}
        description={t('components.secondFactorSelect.description')}
        selected={value === 'email'}
        onSelect={() => onValueChange('email')}
      />
      <SelectCard
        Icon={KeyRound}
        title={t('components.secondFactorSelect.title2')}
        description={t('components.secondFactorSelect.description2')}
        selected={value === 'totp'}
        onSelect={() => onValueChange('totp')}
      />
      {passkeyAvailable && (
        <SelectCard
          Icon={Fingerprint}
          title={t('components.secondFactorSelect.title3')}
          badge={t('components.secondFactorSelect.badge')}
          description={t('components.secondFactorSelect.description3')}
          selected={value === 'passkey'}
          onSelect={() => onValueChange('passkey')}
        />
      )}
    </div>
  );
}

/**
 * Eine der drei Karten. Als eigener Baustein, damit die drei nicht
 * auseinanderlaufen können — sie müssen gleich groß und gleich gewichtet
 * bleiben, sonst wirkt eine davon wie ein Notbehelf.
 */
function SelectCard({
  Icon,
  title,
  description,
  badge,
  selected,
  onSelect,
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
        selected
          ? 'border-primaer bg-primaer-soft'
          : 'border-rahmen bg-flaeche hover:bg-flaeche-3'
      }`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primaer" aria-hidden="true" />
      <div className="flex-1">
        {/* `flex-wrap`: bei 375 px stehen Titel und Abzeichen sonst in einer
            Zeile, die über den Kartenrand hinausläuft. */}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-text">{title}</p>
          {badge && (
            <Badge className="bg-primaer-soft text-primaer-softtext">
              {badge}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-sm text-leise">{description}</p>
      </div>
    </button>
  );
}
