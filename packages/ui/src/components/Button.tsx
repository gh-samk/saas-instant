import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'secondaryGreen' | 'danger' | 'ghost';
  loading?: boolean;
  /** Größe ab `sm`: sm (32px), md (Vorgabe, 40px), lg (44px). Darunter (Telefon) gilt für alle mindestens 44px. */
  size?: 'sm' | 'md' | 'lg';
}

const SIZES: Record<NonNullable<Props['size']>, string> = {
  sm: 'min-h-11 px-3 py-1 text-sm sm:min-h-8',
  md: 'min-h-11 px-4 py-2 text-sm sm:min-h-10',
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
