import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20261117100000_company_status_five',
    'migration.sql',
  ),
  'utf8',
);

describe('Migration company_status_five', () => {
  it('bildet jeden der acht alten Status auf einen der fünf neuen ab', () => {
    const mapping = Object.fromEntries(
      [...SQL.matchAll(/WHEN '(\w+)' THEN '(\w+)'/g)].map((m) => [m[1], m[2]]),
    );
    expect(mapping).toEqual({
      inquiry: 'inquiry',
      demo: 'trial',
      pilot_approved: 'trial',
      pilot_running: 'trial',
      paying: 'paying',
      review_pending: 'paying',
      dormant: 'ended',
      ended: 'ended',
    });
  });

  it('legt Typ, Vorgabe und Index neu an und entfernt den alten Typ', () => {
    expect(SQL).toContain(
      `CREATE TYPE "CompanyStatus_new" AS ENUM ('inquiry', 'trial', 'paying', 'exempt', 'ended')`,
    );
    expect(SQL).toContain('DROP TYPE "CompanyStatus";');
    expect(SQL).toContain(`SET DEFAULT 'inquiry'`);
    expect(SQL).toContain('CREATE INDEX "Company_status_idx"');
  });
});
