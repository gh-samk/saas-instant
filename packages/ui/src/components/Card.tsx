import type { HTMLAttributes, ReactNode } from 'react';

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Grundlegende Inhaltsfläche (Token-basiert, folgt hell/dunkel). */
export function Card({ children, className, ...rest }: Props) {
  return (
    <div
      className={`rounded-lg border border-rahmen bg-flaeche shadow-karte ${className ?? ''}`}
      {...rest}
    >
      {children}
    </div>
  );
}
