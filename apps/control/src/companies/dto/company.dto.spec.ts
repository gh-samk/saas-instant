import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CompanyCreateDto,
  CompanyUpdateDto,
  StatusChangeDto,
} from './company.dto';

/** Prüft wie die globale ValidationPipe: fremde Felder sind verboten. */
function check<T extends object>(
  classValue: new () => T,
  raw: Record<string, unknown>,
) {
  const dto = plainToInstance(classValue, raw, {
    enableImplicitConversion: false,
  });
  return validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('OrganisationAnlegenDto', () => {
  it('verlangt einen Namen', () => {
    const error = check(CompanyCreateDto, {});
    expect(error.map((f) => f.property)).toContain('name');
  });

  it('nimmt Tagesdaten an und weist Zeitstempel ab', () => {
    expect(
      check(CompanyCreateDto, {
        name: 'Solawi',
        pilotDecisionDate: '2026-03-12',
      }),
    ).toHaveLength(0);

    const error = check(CompanyCreateDto, {
      name: 'Solawi',
      pilotDecisionDate: '2026-03-12T00:00:00.000Z',
    });
    expect(error.map((f) => f.property)).toContain('pilotDecisionDate');
  });

  it('weist ein unmögliches Datum ab, statt es später als 500 zu zeigen', () => {
    const error = check(CompanyCreateDto, {
      name: 'Solawi',
      pilotDecisionDate: '2026-02-30',
    });
    expect(error.map((f) => f.property)).toContain('pilotDecisionDate');
  });

  it('nimmt den ÜBERPRÜFUNGSTERMIN nicht entgegen — er wird gerechnet', () => {
    const error = check(CompanyCreateDto, {
      name: 'Solawi',
      reviewDueDate: '2030-01-01',
    });
    expect(error).not.toHaveLength(0);
  });
});

describe('OrganisationBearbeitenDto', () => {
  it('lässt den Status NICHT als Feld-Update durch', () => {
    // Sonst ließe sich die Notiz- und Nachweispflicht des Statuswechsels
    // schlicht umgehen.
    const error = check(CompanyUpdateDto, { status: 'paying' });
    expect(error).not.toHaveLength(0);
  });

  it('lässt die Ansprechpartnerin NICHT als Feld-Update durch', () => {
    const error = check(CompanyUpdateDto, {
      contactName: 'Tim Roth',
    });
    expect(error).not.toHaveLength(0);
  });

  it('erlaubt das Leeren eines Feldes', () => {
    expect(check(CompanyUpdateDto, { city: null })).toHaveLength(0);
  });

  it('lässt einen leeren Namen nicht zu', () => {
    const error = check(CompanyUpdateDto, { name: '' });
    expect(error.map((f) => f.property)).toContain('name');
  });
});

describe('StatusWechselnDto', () => {
  it('kennt nur die acht Status des Datenmodells', () => {
    expect(check(StatusChangeDto, { status: 'paying' })).toHaveLength(0);
    expect(check(StatusChangeDto, { status: 'erfunden' })).not.toHaveLength(0);
  });
});
