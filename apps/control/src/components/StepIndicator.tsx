import { Check } from 'lucide-react';
import { useT } from '../i18n';

interface Props {
  /** Namen der Schritte. */
  steps: string[];
  /** 0-basiert. */
  activeIndex: number;
}

/**
 * Fortschrittsanzeige des Ersteinrichtungs-Wizards. Bewusst ohne Klick-
 * Interaktion: der Wizard erzwingt die lineare Reihenfolge.
 */
export function StepIndicator({ steps, activeIndex }: Props) {
  const t = useT();
  return (
    <ol className="flex items-center" aria-label={t('components.stepIndicator.ariaLabel')}>
      {steps.map((name, i) => {
        const done = i < activeIndex;
        const current = i === activeIndex;
        return (
          <li key={name} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span
                aria-current={current ? 'step' : undefined}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${
                  done
                    ? 'bg-primaer text-primaer-text'
                    : current
                      ? 'bg-primaer-soft text-primaer-softtext ring-2 ring-primaer'
                      : 'bg-flaeche-3 text-leise'
                }`}
              >
                {done ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
              </span>
              <span className="hidden text-xs text-leise sm:block">{name}</span>
              <span className="sr-only">
                {t('components.stepIndicator.label')}{i + 1}: {name},{' '}
                {done ? t('components.stepIndicator.label2') : current ? t('components.stepIndicator.label3') : t('components.stepIndicator.label4')}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={`mx-2 h-0.5 flex-1 ${done ? 'bg-primaer' : 'bg-rahmen'}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
