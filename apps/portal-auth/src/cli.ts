import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { hashPassword } from '@saas-instant/auth-core';
import { AccountsService, ROLES, Role } from './accounts/accounts.service';
import { AppModule } from './app.module';
import { KeysService } from './keys/keys.service';
import { PrismaService } from './prisma.service';

/**
 * Verwaltung des Anmeldedienstes im Container:
 *
 *   node dist/cli.js client upsert --id <slug> --name <Name> --base-url <https://verwaltung> --secret-stdin
 *   node dist/cli.js client list
 *   node dist/cli.js account create-first --email <e> --name <n>
 *   node dist/cli.js account create --email <e> --name <n>
 *   node dist/cli.js account set-role --email <e> --client <slug> --role admin|staff|none
 *   node dist/cli.js account setup-link --email <e>
 *   node dist/cli.js account unlock --email <e>
 *   node dist/cli.js key rotate
 */

function parseFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`Unerwartetes Argument "${arg}".`);
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return flags;
}

function need(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} fehlt.`);
  return value.trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function baseUrlOf(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--base-url muss mit http(s):// beginnen.');
  return url;
}

export async function run(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  const flags = parseFlags(rest);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const prisma = app.get(PrismaService);
    const accounts = app.get(AccountsService);

    if (group === 'client' && command === 'upsert') {
      const id = need(flags, 'id');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('--id muss ein Slug sein (a-z, 0-9, Bindestrich).');
      const name = need(flags, 'name');
      const base = baseUrlOf(need(flags, 'base-url'));
      const origin = base.origin + base.pathname.replace(/\/+$/, '');
      const existing = await prisma.oidcClient.findUnique({ where: { id } });
      let secretHash = existing?.secretHash;
      if (flags['secret-stdin']) {
        const secret = await readStdin();
        if (secret.length < 24) throw new Error('Das Client-Secret ist zu kurz (mindestens 24 Zeichen).');
        secretHash = await hashPassword(secret);
      }
      if (!secretHash) throw new Error('Neue Verwaltung: --secret-stdin ist Pflicht.');
      const data = {
        name,
        secretHash,
        redirectUris: [`${origin}/api/auth/sso/callback`],
        frontchannelLogoutUri: `${origin}/api/auth/sso/frontchannel-logout`,
        postLogoutRedirectUris: [`${origin}/`, `${origin}/login`],
      };
      await prisma.oidcClient.upsert({ where: { id }, create: { id, ...data }, update: data });
      process.stdout.write(`Verwaltung "${id}" ${existing ? 'aktualisiert' : 'angelegt'} (Redirect: ${data.redirectUris[0]}).\n`);
      return 0;
    }
    if (group === 'client' && command === 'list') {
      for (const c of await prisma.oidcClient.findMany({ orderBy: { id: 'asc' } })) {
        process.stdout.write(`${c.id}\t${c.name}\t${c.redirectUris.join(',')}\n`);
      }
      return 0;
    }
    if (group === 'account' && command === 'create-first') {
      if ((await prisma.account.count()) > 0) throw new Error('Es gibt schon Konten; "create-first" ist nur für das allererste Konto.');
      const { link } = await accounts.create({ email: need(flags, 'email'), name: need(flags, 'name'), portalAdmin: true }, 'cli');
      process.stdout.write(`Erstes Konto (Portal-Administration) angelegt.\nEinrichtungslink (einmalig, 3 Tage gültig):\n${link}\n`);
      return 0;
    }
    if (group === 'account' && command === 'create') {
      const { link } = await accounts.create({ email: need(flags, 'email'), name: need(flags, 'name'), portalAdmin: flags['portal-admin'] === true }, 'cli');
      process.stdout.write(`Konto angelegt.\nEinrichtungslink (einmalig, 3 Tage gültig):\n${link}\n`);
      return 0;
    }
    if (group === 'account' && command === 'set-role') {
      const account = await accounts.findByEmail(need(flags, 'email'));
      if (!account) throw new Error('Konto nicht gefunden.');
      const role = need(flags, 'role');
      if (role !== 'none' && !ROLES.includes(role as Role)) throw new Error('--role muss admin, staff oder none sein.');
      await accounts.setRole(account.id, need(flags, 'client'), role as Role | 'none');
      process.stdout.write(`Rolle von ${account.email} in "${need(flags, 'client')}": ${role}.\n`);
      return 0;
    }
    if (group === 'account' && command === 'setup-link') {
      const account = await accounts.findByEmail(need(flags, 'email'));
      if (!account) throw new Error('Konto nicht gefunden.');
      const link = await accounts.issueSetupLink(account.id, account.passwordHash ? 'reset' : 'setup');
      process.stdout.write(`Neuer Link (einmalig, 3 Tage gültig):\n${link}\n`);
      return 0;
    }
    if (group === 'account' && command === 'unlock') {
      const account = await accounts.findByEmail(need(flags, 'email'));
      if (!account) throw new Error('Konto nicht gefunden.');
      await prisma.account.update({ where: { id: account.id }, data: { failedAttempts: 0, lockedUntil: null } });
      process.stdout.write('Sperre aufgehoben.\n');
      return 0;
    }
    if (group === 'key' && command === 'rotate') {
      const result = await app.get(KeysService).rotate();
      process.stdout.write(`Neuer Schlüssel ${result.newKid}; ausgemustert: ${result.retiredKids.join(', ') || '-'} (bleibt bis zum Ablauf im JWKS).\n`);
      return 0;
    }
    process.stderr.write(
      'Aufruf: client upsert|list, account create-first|create|set-role|setup-link|unlock, key rotate\n',
    );
    return 2;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`Fehler: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
