import { useState } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n';
import { readTheme, saveTheme, type ThemeChoice } from '../lib/theme';

const OPTIONS: { value: ThemeChoice; labelKey: string; Icon: LucideIcon }[] = [
  { value: 'system', labelKey: 'components.themeSwitcher.system', Icon: Monitor },
  { value: 'light', labelKey: 'components.themeSwitcher.light', Icon: Sun },
  { value: 'dark', labelKey: 'components.themeSwitcher.dark', Icon: Moon },
];

/** Umschalter System / Hell / Dunkel. Icon plus zugänglicher Name, nie nur Farbe. */
export function ThemeSwitcher() {
  const t = useT();
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);

  return (
    <div
      role="radiogroup"
      aria-label={t('components.themeSwitcher.group')}
      className="inline-flex w-fit shrink-0 rounded-lg border border-rahmen-ui bg-flaeche-3 p-0.5"
    >
      {OPTIONS.map(({ value, labelKey, Icon }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            onClick={() => {
              setChoice(value);
              saveTheme(value);
            }}
            className={`grid h-8 w-8 pointer-coarse:min-w-11 place-items-center rounded-md transition-colors duration-150 ${
              active
                ? 'bg-flaeche text-primaer shadow-segment'
                : 'text-leise hover:text-text'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
