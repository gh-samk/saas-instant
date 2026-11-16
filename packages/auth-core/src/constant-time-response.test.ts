import { describe, expect, it } from 'vitest';
import { withMinDuration } from './constant-time-response';

describe('withMinDuration', () => {
  it('hebt schnelle Arbeit auf die Mindestdauer', async () => {
    const start = Date.now();
    await withMinDuration(60, async () => 'ok');
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  it('wartet auch im Fehlerfall und reicht den Fehler durch', async () => {
    const start = Date.now();
    await expect(
      withMinDuration(60, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });
});
