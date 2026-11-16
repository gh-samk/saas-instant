import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Plus } from 'lucide-react';

/**
 * Touch-Ziele: Unter `sm` (Telefon) mindestens 44 px, ab `sm` das bisherige
 * Mass. jsdom rechnet kein Layout; geprüft werden die Klassen.
 */
describe('Touch-Ziele', () => {
  it.each([
    ['sm', 'sm:min-h-8'],
    ['md', 'sm:min-h-10'],
    ['lg', 'min-h-11'],
  ] as const)('Button %s hat mobil min-h-11 und ab sm das alte Mass', (size, desktop) => {
    render(<Button size={size}>Los</Button>);
    const cls = screen.getByRole('button', { name: 'Los' }).className;
    expect(cls).toContain('min-h-11');
    expect(cls).toContain(desktop);
  });

  it('IconButton ist mobil 44 px und ab sm 36 bzw. 30 px', () => {
    render(
      <>
        <IconButton Icon={Plus} label="Normal" />
        <IconButton Icon={Plus} label="Klein" size="small" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Normal' }).className).toMatch(/h-11 w-11 sm:h-9 sm:w-9/);
    expect(screen.getByRole('button', { name: 'Klein' }).className).toMatch(/h-11 w-11 sm:h-\[30px\] sm:w-\[30px\]/);
  });
});
