import { createHash } from 'node:crypto';
import {
  checkDocument,
  documentLine,
  findNumberGaps,
  isFailure,
} from './integrity';
import { sequenceLine } from './integrity.service';

const sha = (data: string) => createHash('sha256').update(data).digest('hex');

describe('checkDocument (Hash-Vergleich)', () => {
  const bytes = Buffer.from('%PDF-1.7 Beleg');

  it('ok, wenn Bytes und gespeicherte Pruefsumme zusammenpassen', () => {
    expect(checkDocument(bytes, sha('%PDF-1.7 Beleg'))).toMatchObject({ status: 'ok' });
  });

  it('akzeptiert eine in Grossbuchstaben gespeicherte Pruefsumme', () => {
    expect(checkDocument(bytes, sha('%PDF-1.7 Beleg').toUpperCase()).status).toBe('ok');
  });

  it('mismatch, wenn ein einziges Byte anders ist', () => {
    const result = checkDocument(Buffer.from('%PDF-1.7 Beleg!'), sha('%PDF-1.7 Beleg'));
    expect(result.status).toBe('mismatch');
    expect(result.expected).toBe(sha('%PDF-1.7 Beleg'));
    expect(result.actual).toBe(sha('%PDF-1.7 Beleg!'));
  });

  it('missing_content, wenn die Pruefsumme steht, die Bytes aber fehlen', () => {
    expect(checkDocument(null, sha('x')).status).toBe('missing_content');
  });

  it('missing_hash, wenn Bytes ohne Pruefsumme vorliegen', () => {
    expect(checkDocument(bytes, null).status).toBe('missing_hash');
  });

  it('absent (kein Befund), wenn das Dokument nie erzeugt wurde', () => {
    const result = checkDocument(null, null);
    expect(result.status).toBe('absent');
    expect(isFailure(result.status)).toBe(false);
  });

  it('nur ok und absent sind kein Befund', () => {
    expect(isFailure('ok')).toBe(false);
    expect(isFailure('absent')).toBe(false);
    for (const s of ['mismatch', 'missing_content', 'missing_hash'] as const) {
      expect(isFailure(s)).toBe(true);
    }
  });

  it('documentLine nennt erwartet/tatsaechlich nur bei Abweichung', () => {
    expect(documentLine('pdf', checkDocument(bytes, sha('%PDF-1.7 Beleg')))).toEqual({
      check: 'pdf_sha256',
      ok: true,
      status: 'ok',
    });
    const bad = documentLine('xml', checkDocument(bytes, sha('anders')));
    expect(bad).toMatchObject({ check: 'xml_sha256', ok: false, status: 'mismatch' });
    expect(bad.detail).toEqual({ expected: sha('anders'), actual: sha('%PDF-1.7 Beleg') });
  });
});

describe('findNumberGaps (Nummernkreis)', () => {
  it('meldet nichts bei lueckenlosem Kreis', () => {
    const result = findNumberGaps(['2026-001', '2026-002', '2026-003']);
    expect(result).toEqual({ gaps: [], unparseable: [], duplicates: [] });
  });

  it('findet fehlende Nummern je Jahr', () => {
    const result = findNumberGaps([
      '2025-001',
      '2025-002',
      '2026-001',
      '2026-004',
      '2026-005',
    ]);
    expect(result.gaps).toEqual([
      { year: 2026, missing: [2, 3], missingTotal: 2, highest: 5 },
    ]);
  });

  it('vergleicht numerisch: 2026-1000 steht hinter 2026-999', () => {
    const numbers = Array.from({ length: 1000 }, (_, i) =>
      `2026-${String(i + 1).padStart(3, '0')}`,
    );
    expect(findNumberGaps(numbers).gaps).toEqual([]);
  });

  it('beschraenkt auf ein Jahr', () => {
    const result = findNumberGaps(['2025-002', '2026-001'], { onlyYear: 2026 });
    expect(result.gaps).toEqual([]);
  });

  it('meldet unlesbare und doppelte Nummern', () => {
    const result = findNumberGaps(['2026-001', 'ABC', '2026-001']);
    expect(result.unparseable).toEqual(['ABC']);
    expect(result.duplicates).toEqual(['2026-001']);
  });

  it('kappt die Liste der fehlenden Nummern, zaehlt aber alle', () => {
    const result = findNumberGaps(['2026-100'], { maxListed: 5 });
    expect(result.gaps[0]).toMatchObject({ missingTotal: 99, highest: 100 });
    expect(result.gaps[0]?.missing).toEqual([1, 2, 3, 4, 5]);
  });

  it('sequenceLine: ok / gap', () => {
    expect(sequenceLine(findNumberGaps(['2026-001']))).toEqual({
      check: 'number_sequence',
      ok: true,
      status: 'ok',
    });
    const bad = sequenceLine(findNumberGaps(['2026-002']));
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe('gap');
    expect(bad.detail).toBeDefined();
  });
});
