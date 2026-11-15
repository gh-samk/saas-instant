import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntryBadge } from './EntryBadge';
import { ENTRY, type EntryType } from '../entry-colors';

const TYPES: EntryType[] = [
  'suggestion',
  'concern',
  'objection',
  'decision',
];

describe('EintragAbzeichen', () => {
  it('trägt für jeden Typ ein Text-Label (nicht nur Farbe)', () => {
    for (const typeValue of TYPES) {
      const { unmount } = render(<EntryBadge typeValue={typeValue} />);
      // Barrierefreiheit: die Bedeutung ist als Text lesbar, nicht nur farblich.
      expect(screen.getByText(ENTRY[typeValue].label)).toBeInTheDocument();
      unmount();
    }
  });
});
