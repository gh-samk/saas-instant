import { TRIAL_DAYS } from './deadlines';

describe('TRIAL_DAYS', () => {
  it('die Testphase dauert 14 Tage', () => {
    expect(TRIAL_DAYS).toBe(14);
  });
});
