import type { ConsentStatus } from '.prisma/control-client';
import { mayBlockWrite, BLOCK_RANK, strongerState } from './block-rank';

const ALL: ConsentStatus[] = [
  'unconfirmed',
  'confirmed',
  'unsubscribed',
  'hard_bounced',
  'spam_reported',
];

const BLOCK = ['unsubscribed', 'hard_bounced', 'spam_reported'] as const;

/**
 * [K4] DIE RANGORDNUNG, FÜR SICH GENOMMEN.
 *
 * Der Integrationstest prüft dieselbe Matrix gegen die Datenbank; dieser hier
 * prüft die Regel ohne alles drumherum und läuft in Millisekunden.
 */
describe('[K4] Eine Sperre wird nur stärker', () => {
  it('kennt jeden Zustand', () => {
    for (const state of ALL) {
      expect(BLOCK_RANK[state]).toBeGreaterThanOrEqual(0);
    }
  });

  it('gibt den beiden ungesperrten Zuständen denselben, niedrigsten Rang', () => {
    expect(BLOCK_RANK.unconfirmed).toBe(0);
    expect(BLOCK_RANK.confirmed).toBe(0);
  });

  it('ordnet die drei Sperren streng aufsteigend', () => {
    expect(BLOCK_RANK.unsubscribed).toBeLessThan(BLOCK_RANK.hard_bounced);
    expect(BLOCK_RANK.hard_bounced).toBeLessThan(BLOCK_RANK.spam_reported);
  });

  it('schreibt auf eine leere Zeile jeden Sperrzustand', () => {
    for (const block of BLOCK) {
      expect(mayBlockWrite(null, block)).toBe(true);
    }
  });

  /** DER GEMESSENE FALL: spam_gemeldet darf nicht auf abgemeldet fallen. */
  it('weist jede Abschwächung ab', () => {
    expect(mayBlockWrite('spam_reported', 'unsubscribed')).toBe(false);
    expect(mayBlockWrite('spam_reported', 'hard_bounced')).toBe(false);
    expect(mayBlockWrite('hard_bounced', 'unsubscribed')).toBe(false);
  });

  it('weist auch die Wiederholung derselben Sperre ab (nichts zu tun)', () => {
    for (const block of BLOCK) {
      expect(mayBlockWrite(block, block)).toBe(false);
    }
  });

  it('lässt jede Verschärfung zu', () => {
    expect(mayBlockWrite('unsubscribed', 'hard_bounced')).toBe(true);
    expect(mayBlockWrite('unsubscribed', 'spam_reported')).toBe(true);
    expect(mayBlockWrite('hard_bounced', 'spam_reported')).toBe(true);
    for (const block of BLOCK) {
      expect(mayBlockWrite('confirmed', block)).toBe(true);
      expect(mayBlockWrite('unconfirmed', block)).toBe(true);
    }
  });

  /**
   * DIE GANZE MATRIX, ohne Ausnahme: Der Zustand danach ist NIE schwächer als
   * der davor. Diese eine Aussage ist der Kern von [K4].
   */
  it('lässt den Rang über die ganze Matrix hinweg niemals sinken', () => {
    for (const before of ALL) {
      for (const block of BLOCK) {
        const afterwards = strongerState(before, block);
        expect(BLOCK_RANK[afterwards]).toBeGreaterThanOrEqual(BLOCK_RANK[before]);
        // Und die Sperre wirkt: aus einem ungesperrten Zustand wird immer eine.
        if (BLOCK_RANK[before] === 0) expect(afterwards).toBe(block);
      }
    }
  });
});
