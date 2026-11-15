import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLiteral, SRC, walk, withoutComments } from './route-parsing';

/**
 * ===========================================================================
 * ROHES SQL GEGEN DAS SCHEMA
 * ===========================================================================
 *
 * `$queryRaw`/`$executeRaw` sind für den Compiler Zeichenketten. Nach der
 * Umbenennung von Tabellen und Spalten blieb so ein Rest unbemerkt, bis die
 * Zeile zur Laufzeit lief. Dieser Test liest jedes rohe Statement und prüft,
 * dass jede darin zitierte Tabelle und Spalte existiert — im Prisma-Schema UND
 * in den Migrationen (das ist, was die Datenbank wirklich hat).
 *
 * Unbekanntes lässt den Test scheitern; er prüft also auch, dass er überhaupt
 * Statements findet.
 */

const ROOT = join(SRC, '..');

interface Catalog {
  tables: Map<string, Set<string>>;
}

/** Tabellen und Spalten aus `schema.prisma` (kein @map im Projekt). */
export function schemaCatalog(source: string): Catalog {
  const text = withoutComments(source.replace(/\/\/.*$/gm, ''));
  const models = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const names = new Set(models.map((m) => m[1]!));
  expect(/@@?map\(/.test(text)).toBe(false); // sonst stimmen Namen nicht mehr
  const tables = new Map<string, Set<string>>();
  for (const m of models) {
    const columns = new Set<string>();
    for (const line of m[2]!.split('\n')) {
      const f = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!f || line.trim().startsWith('@@')) continue;
      const [, name, type, list] = f;
      if (list || names.has(type!)) continue; // Beziehung, keine Spalte
      columns.add(name!);
    }
    tables.set(m[1]!, columns);
  }
  return { tables };
}

/** Tabellen und Spalten aus allen Migrationen (CREATE TABLE, ADD COLUMN, RENAME). */
export function migrationCatalog(sql: string): Catalog {
  const tables = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    const columns = new Set<string>();
    for (const line of m[2]!.split('\n')) {
      const c = /^\s*"(\w+)"\s+\S/.exec(line);
      if (c) columns.add(c[1]!);
    }
    tables.set(m[1]!, columns);
  }
  for (const m of sql.matchAll(/ALTER TABLE "(\w+)"\s+ADD COLUMN\s+"(\w+)"/g)) {
    tables.get(m[1]!)?.add(m[2]!);
  }
  return { tables };
}

export interface RawStatement {
  file: string;
  line: number;
  sql: string;
}

/** Alle rohen Statements; `${…}` ist durch \u0000 ersetzt. */
export function rawStatements(): RawStatement[] {
  const files = walk(
    SRC,
    (f) =>
      /\.ts$/.test(f) &&
      !/\.(spec|test)\.ts$/.test(f) &&
      !/[\\/]test-support[\\/]/.test(f) &&
      !/[\\/]contract[\\/]/.test(f),
  );
  const out: RawStatement[] = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    const re = /\$(?:queryRaw|executeRaw)(?:Unsafe)?\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      let i = m.index + m[0].length;
      while (/\s/.test(source[i]!)) i += 1;
      if (source[i] === '<') {
        let depth = 0;
        do {
          if (source[i] === '<') depth += 1;
          else if (source[i] === '>' && source[i - 1] !== '=') depth -= 1;
          i += 1;
        } while (depth > 0 && i < source.length);
        while (/\s/.test(source[i]!)) i += 1;
      }
      if (source[i] === '(') {
        i += 1;
        while (/\s/.test(source[i]!)) i += 1;
      }
      if (!['`', "'", '"'].includes(source[i]!)) continue;
      out.push({
        file,
        line: source.slice(0, m.index).split('\n').length,
        sql: readLiteral(source, i).value,
      });
    }
  }
  return out;
}

const RESERVED = new Set([
  'where', 'set', 'on', 'using', 'inner', 'left', 'right', 'full', 'cross',
  'join', 'group', 'order', 'limit', 'returning', 'for', 'natural', 'values',
  'select', 'from', 'as', 'having', 'union', 'offset', 'lateral',
]);

/** Meldet jedes Unbekannte in einem Statement; leere Liste = in Ordnung. */
export function checkStatement(sql: string, catalog: Catalog): string[] {
  const problems: string[] = [];
  const ctes = new Set(
    [...sql.matchAll(/(?:\bWITH|,)\s*([a-z_]\w*)\s+AS\s*\(/gi)].map((m) =>
      m[1]!.toLowerCase(),
    ),
  );
  const aliasToTable = new Map<string, string>();
  const used = new Set<string>();
  const tableSpans: [number, number][] = [];

  const ref =
    /(?<!\bFOR\s)\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(?:"(\w+)"|([A-Za-z_]\w*))(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (const m of sql.matchAll(ref)) {
    const quoted = m[1];
    const bare = m[2];
    if (bare !== undefined) {
      if (!ctes.has(bare.toLowerCase()) && bare.toLowerCase() !== 'only') {
        problems.push(
          `Tabelle ${bare} ohne Anführungszeichen — Postgres sucht "${bare.toLowerCase()}", Prisma legt "${bare}" an`,
        );
      }
      continue;
    }
    const start = m.index! + m[0].indexOf(`"${quoted}"`);
    tableSpans.push([start, start + quoted!.length + 2]);
    if (!catalog.tables.has(quoted!)) {
      problems.push(`Tabelle "${quoted}" gibt es nicht`);
      continue;
    }
    used.add(quoted!);
    const alias = m[3];
    if (alias && !RESERVED.has(alias.toLowerCase())) aliasToTable.set(alias, quoted!);
  }

  for (const m of sql.matchAll(/(?:\b([A-Za-z_]\w*)\.)?"(\w+)"/g)) {
    const at = m.index! + (m[1] ? m[1].length + 1 : 0);
    if (tableSpans.some(([a, b]) => at >= a && at < b)) continue;
    const qualifier = m[1];
    const name = m[2]!;
    // Ausgabename (`AS "count"`), keine Spalte.
    if (/\bAS\s*$/i.test(sql.slice(0, at))) continue;
    if (qualifier) {
      const table = aliasToTable.get(qualifier) ?? (catalog.tables.has(qualifier) ? qualifier : undefined);
      if (!table) problems.push(`Alias ${qualifier} unbekannt (bei "${name}")`);
      else if (!catalog.tables.get(table)!.has(name))
        problems.push(`Spalte "${name}" gibt es in "${table}" nicht`);
      continue;
    }
    const owners = [...used].filter((t) => catalog.tables.get(t)!.has(name));
    if (owners.length === 0)
      problems.push(
        `Spalte "${name}" gibt es in keiner der Tabellen (${[...used].join(', ') || 'keine'})`,
      );
  }
  return problems;
}

const schema = schemaCatalog(readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8'));
const migrations = migrationCatalog(
  readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => readFileSync(join(ROOT, 'prisma/migrations', d.name, 'migration.sql'), 'utf8'))
    .join('\n'),
);
const statements = rawStatements();

describe('rohes SQL gegen das Schema', () => {
  it('findet die rohen Statements (sonst prüft der Test nichts)', () => {
    expect(statements.length).toBeGreaterThanOrEqual(15);
    expect(schema.tables.size).toBeGreaterThan(15);
    expect(migrations.tables.size).toBe(schema.tables.size);
  });

  it('Schema und Migrationen kennen dieselben Tabellen und Spalten', () => {
    for (const [table, columns] of schema.tables) {
      expect([...(migrations.tables.get(table) ?? [])].sort()).toEqual([...columns].sort());
    }
  });

  it.each([
    ['schema.prisma', schema],
    ['Migrationen', migrations],
  ] as const)('jede zitierte Tabelle und Spalte existiert (%s)', (_name, catalog) => {
    const problems = statements.flatMap((s) =>
      checkStatement(s.sql, catalog).map(
        (p) => `${p}  (${s.file.replace(SRC, 'src')}:${s.line})`,
      ),
    );
    expect(problems).toEqual([]);
  });

  describe('der Prüfer selbst', () => {
    it('erkennt eine unbekannte Tabelle, Spalte und eine Spalte der falschen Tabelle', () => {
      expect(checkStatement('SELECT "id" FROM "Benutzer"', schema)).toHaveLength(2);
      expect(checkStatement('SELECT "nutzername" FROM "User"', schema)).toEqual([
        expect.stringContaining('"nutzername"'),
      ]);
      expect(checkStatement('SELECT b."gone" FROM "User" b', schema)).toEqual([
        expect.stringContaining('"gone"'),
      ]);
      expect(checkStatement('SELECT "id" FROM "Company" WHERE "pdfContent" IS NULL', schema)).toEqual([
        expect.stringContaining('"pdfContent"'),
      ]);
      expect(checkStatement('SELECT 1 FROM user', schema)).toHaveLength(1);
    });
    it('lässt gültiges SQL durch', () => {
      expect(
        checkStatement(
          'SELECT b."id" FROM "User" b WHERE EXISTS (SELECT 1 FROM "PasskeyCredential" p WHERE p."userId" = b."id") FOR UPDATE OF b',
          schema,
        ),
      ).toEqual([]);
    });
  });
});
