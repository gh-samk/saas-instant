import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { BackupRejectedError } from './instance.errors';
import { BackupKeyGuard, same } from './backup-key.guard';

const KEY = 'x'.repeat(40);

function guardWith(env: Record<string, string>): BackupKeyGuard {
  return new BackupKeyGuard({ get: (k: string) => env[k] } as never);
}

function inquiryWith(key?: string): ExecutionContext {
  const req = {
    headers: key ? { 'x-backup-key': key } : {},
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('BackupKeyGuard', () => {
  it('existiert ohne CONTROL_BACKUP_KEY nicht (404)', () => {
    expect(() => guardWith({}).canActivate(inquiryWith(KEY))).toThrow(
      NotFoundException,
    );
  });

  it('behandelt einen zu kurzen Schlüssel wie einen fehlenden', () => {
    expect(() =>
      guardWith({ CONTROL_BACKUP_KEY: 'kurz' }).canActivate(inquiryWith('kurz')),
    ).toThrow(NotFoundException);
  });

  it('lässt den richtigen Schlüssel durch', () => {
    expect(
      guardWith({ CONTROL_BACKUP_KEY: KEY }).canActivate(
        inquiryWith(KEY),
      ),
    ).toBe(true);
  });

  it('weist einen falschen Schlüssel ab', () => {
    expect(() =>
      guardWith({ CONTROL_BACKUP_KEY: KEY }).canActivate(
        inquiryWith('y'.repeat(40)),
      ),
    ).toThrow(BackupRejectedError);
  });

  it('weist eine Anfrage ganz ohne Kopfzeile ab', () => {
    expect(() =>
      guardWith({ CONTROL_BACKUP_KEY: KEY }).canActivate(inquiryWith()),
    ).toThrow(BackupRejectedError);
  });

  it('wirft auch bei abweichender Länge keine RangeError', () => {
    // Zeitkonstanter Vergleich über SHA-256: `timingSafeEqual` verlangt
    // gleiche Pufferlänge. Ohne den Abdruck flöge hier eine RangeError, und
    // die Länge des richtigen Schlüssels wäre über die Antwort ablesbar.
    expect(() =>
      guardWith({ CONTROL_BACKUP_KEY: KEY }).canActivate(inquiryWith('y')),
    ).toThrow(BackupRejectedError);
  });

  it('vergleicht zeitkonstant über gleich lange Abdrücke', () => {
    expect(same('abc', 'abc')).toBe(true);
    expect(same('abc', 'abd')).toBe(false);
    expect(same('kurz', 'viel laenger')).toBe(false);
  });
});
