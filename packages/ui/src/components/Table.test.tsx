import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table } from './Table';

/**
 * Unter `table-layout: auto` bestimmt der längste Inhalt die
 * Spaltenbreite. `truncate` auf einem Element INNERHALB der Zelle bleibt dann
 * wirkungslos, und die Tabelle wächst über ihre Hülle hinaus — gemessen bei
 * 768 px mit einem hundert Zeichen langen Vereinsnamen: 1309 px Inhalt in
 * einer 734 px breiten Hülle.
 *
 * jsdom rechnet kein Layout; geprüft wird deshalb der Mechanismus, der es im
 * Browser verhindert: feste Spaltenbreiten ab `sm` plus `<colgroup>`.
 */
/**
 * Bewusst KEINE echten Tailwind-Klassen: Tailwind durchsucht auch diese Datei
 * und nähme sie als benutzt auf — die Regeln landeten dann im Stylesheet jeder
 * Anwendung, die `@saas-instant/ui` einbindet. Geprüft wird ohnehin nur, dass die
 * übergebenen Klassen unverändert am <col> landen.
 */
const WIDE = 'pruef-breit';
const NARROW = 'pruef-schmal';

describe('Tabelle', () => {
  it('bleibt ohne Breitenangabe unverändert — bestehende Aufrufer merken nichts', () => {
    render(
      <Table columns={['A', 'B']} label="without">
        <tr>
          <td>1</td>
          <td>2</td>
        </tr>
      </Table>,
    );
    const table = screen.getByRole('table');
    expect(table.className).toBe('w-full text-left text-sm');
    expect(table.querySelector('colgroup')).toBeNull();
  });

  it('schaltet mit Breitenangabe auf feste Spalten und legt eine colgroup an', () => {
    render(
      <Table
        columns={['A', 'B']}
        columnsWidths={[WIDE, NARROW]}
        label="withValue"
      >
        <tr>
          <td>1</td>
          <td>2</td>
        </tr>
      </Table>,
    );
    const table = screen.getByRole('table');
    expect(table.className).toContain('sm:table-fixed');

    const columns = table.querySelectorAll('colgroup col');
    expect(columns).toHaveLength(2);
    expect(columns[0].className).toBe(WIDE);
    expect(columns[1].className).toBe(NARROW);
  });

  it('verträgt eine zu kurze Breitenliste, ohne undefined ins Markup zu schreiben', () => {
    render(
      <Table columns={['A', 'B']} columnsWidths={[WIDE]} label="short">
        <tr>
          <td>1</td>
          <td>2</td>
        </tr>
      </Table>,
    );
    const columns = screen.getByRole('table').querySelectorAll('colgroup col');
    expect(columns).toHaveLength(2);
    expect(columns[1].className).toBe('');
  });
});
