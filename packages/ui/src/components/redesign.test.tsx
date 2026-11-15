import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CheckCircle2, Landmark } from 'lucide-react';
import { FilterChips } from './FilterChips';
import { DangerCard } from './DangerCard';
import { IconButton } from './IconButton';
import { MetricTile } from './MetricTile';
import { NoticeBar } from './NoticeBar';
import { StatusPill } from './StatusPill';
import { Table } from './Table';
import { RowLink } from './RowLink';

/**
 * Die Bausteine für dichte Listen- und Detailansichten.
 *
 * Geprüft wird nicht, ob sie „richtig aussehen" — das entscheidet der
 * Screenshot-Vergleich. Geprüft wird, was eine Klasse allein nicht hergibt:
 * dass die Bedeutung ankommt (Wort statt nur Farbe), dass jeder Icon-Knopf
 * eine Beschriftung trägt, und dass die Erweiterung der `Tabelle` für
 * bestehende Aufrufer folgenlos bleibt.
 */

describe('StatusPille — Farbe ist nie das alleinige Signal', () => {
  it('zeigt das Wort, nicht nur die Farbe', () => {
    render(<StatusPill kind="confirmed">Zahlend</StatusPill>);
    expect(screen.getByText('Zahlend')).toBeInTheDocument();
  });

  it('hält den Punkt vor der Vorlesestimme verborgen', () => {
    // Ein Punkt ohne Bedeutung, der vorgelesen wird, ist Lärm. Die Aussage
    // steht im Wort daneben.
    const { container } = render(
      <StatusPill kind="attention" withPoint>
        Ruhend
      </StatusPill>,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('trägt einen Zusatz in derselben Pille, nicht in einer zweiten', () => {
    // „Testphase" mit „läuft" darunter ist EINE Aussage. Zwei Pillen wären zwei.
    render(
      <StatusPill kind="notice" extra="läuft">
        Testphase
      </StatusPill>,
    );
    const pill = screen.getByText('Testphase').closest('span');
    expect(within(pill!).getByText('läuft')).toBeInTheDocument();
  });
});

describe('IconKnopf — ohne Beschriftung nicht baubar', () => {
  it('setzt aria-label UND title aus derselben Angabe', () => {
    render(<IconButton Icon={CheckCircle2} label="Als bezahlt markieren" />);
    const button = screen.getByRole('button', { name: 'Als bezahlt markieren' });
    expect(button).toHaveAttribute('title', 'Als bezahlt markieren');
  });

  it('versteckt das Symbol vor der Vorlesestimme', () => {
    // Sonst hört man den Namen des Symbols zusätzlich zur Beschriftung.
    const { container } = render(<IconButton Icon={CheckCircle2} label="Ansehen" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('FilterChips — Schalter, keine Registerkarten', () => {
  const CHIPS = [
    { value: 'all' as const, label: 'Alle', count: 94 },
    { value: 'inquiry' as const, label: 'Anfrage', count: 12 },
    { value: 'overdue' as const, label: 'Überfällig', count: 0 },
  ];

  it('meldet den gewählten Chip als gedrückt', () => {
    render(
      <FilterChips chips={CHIPS} active="inquiry" onSelect={() => {}} label="Status" />,
    );
    expect(screen.getByRole('button', { name: /Anfrage/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Alle/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('BLENDET EINEN CHIP MIT NULL NICHT AUS', () => {
    // „Überfällig 0" ist eine gute Nachricht — und eine Leiste, deren
    // Einträge wandern, lässt sich nicht blind bedienen.
    render(<FilterChips chips={CHIPS} active="all" onSelect={() => {}} label="Status" />);
    expect(screen.getByRole('button', { name: /Überfällig/ })).toBeInTheDocument();
  });

  it('gibt den gewählten Wert weiter', () => {
    const selected = vi.fn();
    render(<FilterChips chips={CHIPS} active="all" onSelect={selected} label="Status" />);
    fireEvent.click(screen.getByRole('button', { name: /Anfrage/ }));
    expect(selected).toHaveBeenCalledWith('inquiry');
  });
});

describe('Kennzahlkachel — jede Zahl führt irgendwohin', () => {
  it('ist ein Knopf und meldet den Klick', () => {
    const clicked = vi.fn();
    render(
      <MetricTile
        Icon={Landmark}
        number="1.860,00 €"
        label="Offene Beträge"
        onClick={clicked}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Offene Beträge/ }));
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('ZeilenLink — führt hin, löst nichts aus', () => {
  it('bleibt ein echter Verweis, damit Mittelklick funktioniert', () => {
    render(<RowLink href="/organisationen/1">Erledigen</RowLink>);
    expect(screen.getByRole('link', { name: /Erledigen/ })).toHaveAttribute(
      'href',
      '/organisationen/1',
    );
  });
});

describe('NoticeBar und GefahrKarte', () => {
  it('nimmt einen Knopf neben den Satz', () => {
    render(
      <NoticeBar kind="confirmed" action={<button type="button">Einwilligungen</button>}>
        Versand nur an bestätigte Einwilligungen.
      </NoticeBar>,
    );
    expect(screen.getByRole('button', { name: 'Einwilligungen' })).toBeInTheDocument();
  });

  it('GefahrKarte trägt Titel, eine Zeile und den Knopf', () => {
    render(
      <DangerCard title="Kontaktdaten löschen" action={<button type="button">Löschen …</button>}>
        Personenbezug entfernen · Datensatz und Verlauf bleiben · endgültig
      </DangerCard>,
    );
    expect(screen.getByRole('heading', { name: 'Kontaktdaten löschen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Löschen …' })).toBeInTheDocument();
  });
});

describe('Tabelle — die Erweiterung ist rückwirkungsfrei', () => {
  function build(extra: Record<string, unknown>) {
    const { container } = render(
      <Table columns={['A', 'B']} label="p" {...extra}>
        <tr>
          <td>1</td>
          <td>2</td>
        </tr>
      </Table>,
    );
    return container;
  }

  it('sieht ohne neue Angaben aus wie zuvor', () => {
    // Der Bestand ruft die Tabelle ohne `variante` auf. Änderte sich die
    // Vorgabe, zöge das 47 Dateien in apps/web mit.
    const without = build({});
    const head = without.querySelector('thead');
    expect(head?.className).toContain('bg-flaeche-3');
    expect(head?.className).not.toContain('bg-flaeche-4');
    expect(without.querySelector('table')?.className).not.toContain('ziffern-tabellarisch');
  });

  it('schaltet erst mit variante="liste" auf den dichten Stil um', () => {
    const withValue = build({ variant: 'list' });
    expect(withValue.querySelector('thead')?.className).toContain('bg-flaeche-4');
    expect(withValue.querySelector('tbody')?.className).toContain('divide-rahmen-leise');
    expect(withValue.querySelector('table')?.className).toContain('ziffern-tabellarisch');
  });

  it('rückt nur auf Verlangen die letzte Spalte nach rechts', () => {
    expect(build({}).querySelector('table')?.className).not.toContain('last-child');
    expect(build({ actionColumn: true }).querySelector('table')?.className).toContain(
      'td:last-child',
    );
  });
});
