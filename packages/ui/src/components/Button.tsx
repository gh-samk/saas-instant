import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'secondaryGreen' | 'danger' | 'ghost';
  loading?: boolean;
  /** Größe: sm (32px), md (Vorgabe, 40px), lg (44px). Auf Touchgeräten gilt mindestens 44px. */
  size?: 'sm' | 'md' | 'lg';
}

const SIZES: Record<NonNullable<Props['size']>, string> = {
  sm: 'min-h-8 px-3 py-1 text-sm',
  md: 'min-h-10 px-4 py-2 text-sm',
  lg: 'min-h-11 px-5 py-2.5 text-base',
};

const STYLES: Record<NonNullable<Props['variant']>, string> = {
  primary:
    'bg-primaer text-primaer-text hover:bg-primaer-hover disabled:bg-knopf-gesperrt disabled:text-still',
  secondary:
    'bg-flaeche text-text border border-rahmen-ui hover:bg-flaeche-3 disabled:opacity-50',
  // Umrandeter „Hinzufügen"-Button mit grüner Schrift (wie im Design).
  secondaryGreen:
    'bg-flaeche text-primaer border border-rahmen-ui hover:bg-primaer-soft disabled:opacity-50',
  danger: 'bg-gefahr text-gefahr-text hover:opacity-90 disabled:opacity-50',
  ghost: 'text-text hover:bg-flaeche-3 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  loading = false,
  size = 'md',
  className,
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-150 disabled:cursor-not-allowed ${SIZES[size]} ${STYLES[variant]} ${className ?? ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
