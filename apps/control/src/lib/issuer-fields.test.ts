import { describe, expect, it } from 'vitest';
import { emptyIssuerProfile, validateIssuerProfile } from '@saas-instant/shared';
import { LEGAL_FORM_ORDER, planFields, requiredPaths, setPathValue, getPathValue } from './issuer-fields';

describe('Pflichtfelder je Rechtsform', () => {
  it('es gibt alle acht Rechtsformen', () => {
    expect([...LEGAL_FORM_ORDER].sort()).toEqual(
      ['eg', 'einzelunternehmen', 'ev', 'gbr', 'gmbh', 'gmbh_co_kg', 'ohg', 'ug'],
    );
  });

  for (const form of LEGAL_FORM_ORDER) {
    for (const registered of [false, true]) {
      it(`${form} (eingetragen: ${registered}) stimmt mit der Prüfung in shared überein`, () => {
        // Land leeren: die Vorgabe „Deutschland" würde es sonst nie als fehlend melden.
        const profile = { ...emptyIssuerProfile(form), registered, country: '' };
        const fromShared = validateIssuerProfile(profile)
          .filter((i) => i.code === 'missing' && i.field !== 'vatId')
          .map((i) => i.field)
          .sort();
        expect(requiredPaths(profile).sort()).toEqual(fromShared);
      });

      it(`${form} (eingetragen: ${registered}): jedes Pflichtfeld wird geplant, und nur diese`, () => {
        const profile = { ...emptyIssuerProfile(form), registered };
        const planned = planFields(profile)
          .flatMap((s) => s.fields)
          .filter((f) => f.required)
          .map((f) => f.path)
          .sort();
        expect(planned).toEqual(requiredPaths(profile).sort());
      });
    }
  }

  it('Ausstehende Einlagen sind Pflicht, sobald ein Stammkapital steht', () => {
    const base = emptyIssuerProfile('gmbh');
    const flag = (p: typeof base) =>
      planFields(p).flatMap((s) => s.fields).find((f) => f.path === 'outstandingContributions')!.required;
    expect(flag(base)).toBe(false);
    expect(flag({ ...base, shareCapital: '25.000' })).toBe(true);
  });

  it('setzt und liest verschachtelte Pfade', () => {
    const p = setPathValue(emptyIssuerProfile('gmbh_co_kg'), 'generalPartner.seat', 'Berlin');
    expect(getPathValue(p, 'generalPartner.seat')).toBe('Berlin');
    expect(p.generalPartner.name).toBe('');
  });
});
