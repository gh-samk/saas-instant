import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Menu, type MenuItem } from './Menu';

function show(items?: MenuItem[]) {
  const onA = vi.fn();
  const onB = vi.fn();
  render(
    <div>
      <Menu
        label="Weitere"
        items={
          items ?? [
            { id: 'a', label: 'Erste', description: 'Erklärung A', onSelect: onA },
            { id: 'b', label: 'Zweite', onSelect: onB },
            { id: 'c', label: 'Dritte', href: '/x' },
          ]
        }
      />
      <button type="button">Außerhalb</button>
    </div>,
  );
  return { onA, onB, trigger: screen.getByRole('button', { name: /Weitere/ }) };
}

describe('Menu', () => {
  it('ist zu, trägt aria-haspopup und aria-expanded und öffnet per Klick', () => {
    const { trigger } = show();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    // Der erste Eintrag bekommt den Fokus.
    expect(screen.getByRole('menuitem', { name: /Erste/ })).toHaveFocus();
  });

  it('zeigt den erklärenden Satz und macht aus href einen echten Link', () => {
    const { trigger } = show();
    fireEvent.click(trigger);
    expect(screen.getByText('Erklärung A')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Dritte' })).toHaveAttribute(
      'href',
      '/x',
    );
  });

  it('bewegt den Fokus mit den Pfeiltasten, mit Umbruch, und Pos1/Ende', () => {
    const { trigger } = show();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Zweite' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Erste/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Dritte' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: /Erste/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Dritte' })).toHaveFocus();
  });

  it('öffnet vom Knopf aus mit Pfeil unten (erster) und Pfeil oben (letzter)', () => {
    const { trigger } = show();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Dritte' })).toHaveFocus();
  });

  it('schließt mit Escape und gibt den Fokus an den Knopf zurück', () => {
    const { trigger } = show();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('schließt bei Klick außerhalb', () => {
    const { trigger } = show();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Außerhalb' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('führt die Wahl aus, schließt und gibt den Fokus zurück', () => {
    const { trigger, onB } = show();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zweite' }));
    expect(onB).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('klappt beim zweiten Klick auf den Knopf wieder zu', () => {
    const { trigger } = show();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
