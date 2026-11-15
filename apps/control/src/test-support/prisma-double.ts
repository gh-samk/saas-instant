import { randomUUID } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Schlanker In-Memory-Ersatz für den Prisma-Client in Unit-Tests.
 *
 * Bewusst kein Mock, der nur Aufrufe zählt: die Tests zur Kontosperre und zur
 * Einmaligkeit der Wiederherstellungscodes brauchen echtes Verhalten,
 * insbesondere das bedingte `updateMany` (Nebenläufigkeit).
 *
 * Nur die tatsächlich benutzten Aufrufe sind umgesetzt; alles andere fehlt
 * absichtlich, damit ein unbeabsichtigter neuer Zugriff im Test auffällt.
 */

export interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  passwordHash: string | null;
  totpSecret: string | null;
  totpSecretPending: string | null;
  totpPendingValidUntil: Date | null;
  totpLastStep: number | null;
  loginCodeEmail: string | null;
  loginCodeEnabled: boolean;
  sessionGeneration: number;
  loginFlowGeneration: number;
  lastLoginAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  deactivatedAt: Date | null;
}

export interface CodeRow {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface EmailCodeRow {
  id: string;
  userId: string;
  codeHash: string;
  targetEmail: string;
  forSetup: boolean;
  createdAt: Date;
  expiresAt: Date;
  failedAttempts: number;
  consumedAt: Date | null;
}

export interface DeviceRow {
  id: string;
  userId: string;
  label: string;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  validUntil: Date;
}

export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface EmergencyRow {
  id: string;
  userId: string;
  kind: 'passkey' | 'passwort';
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  actor: string;
  action: string;
  objectType: string;
  objectId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  ip: string | null;
  userAgent: string | null;
  timestamp: Date;
}

export interface DoubleData {
  user: UserRow[];
  codes: CodeRow[];
  emailCodes: EmailCodeRow[];
  devices: DeviceRow[];
  passkeys: PasskeyRow[];
  emergency: EmergencyRow[];
  audit: AuditRow[];
}

/** Legt eine Benutzerzeile mit sinnvollen Vorgaben an. */
export function buildUser(part: Partial<UserRow> = {}): UserRow {
  return {
    id: part.id ?? randomUUID(),
    name: part.name ?? 'Sam Verwalterin',
    username: part.username ?? 'sam',
    email: part.email ?? 'inhaber@example.com',
    role: part.role ?? 'owner',
    passwordHash: part.passwordHash ?? null,
    totpSecret: part.totpSecret ?? null,
    totpSecretPending: part.totpSecretPending ?? null,
    totpPendingValidUntil: part.totpPendingValidUntil ?? null,
    totpLastStep: part.totpLastStep ?? null,
    loginCodeEmail: part.loginCodeEmail ?? null,
    loginCodeEnabled: part.loginCodeEnabled ?? false,
    sessionGeneration: part.sessionGeneration ?? 0,
    loginFlowGeneration: part.loginFlowGeneration ?? 0,
    lastLoginAt: part.lastLoginAt ?? null,
    failedAttempts: part.failedAttempts ?? 0,
    lockedUntil: part.lockedUntil ?? null,
    // ZUGANG ENTZOGEN — die Vorgabe ist „nicht entzogen".
    //
    // Sie steht hier und nicht als Nachsicht in der Prüfung: Ein fehlendes
    // Feld darf nicht „nicht deaktiviert" bedeuten. Sonst käme ein Konto,
    // dessen Spalte jemand beim Lesen zu selektieren vergisst, durch die
    // Anmeldung — und das ist genau der Fehler, den die Prüfung verhindern
    // soll. Die Attrappe füllt das Feld, wie es die Datenbank tut.
    deactivatedAt: part.deactivatedAt ?? null,
  };
}

/** Vergleichsoperatoren, die die Anwendung tatsächlich benutzt. */
interface Comparison {
  lte?: Date;
  lt?: number;
  gt?: Date;
  not?: null;
}

interface WoId {
  id?: string;
  username?: string;
  email?: string;
  kind?: string;
  tokenHash?: string;
  credentialId?: string;
  userId?: string;
  consumedAt?: Date | null | Comparison;
  createdAt?: Date | Comparison;
  redeemedAt?: Date | null;
  totpLastStep?: number | null | Comparison;
  forSetup?: boolean;
  expiresAt?: Date | Comparison;
  OR?: WoId[];
  AND?: WoId[];
}

/** Ist der Wert ein Operator-Objekt wie `{ lte: … }` statt ein Literal? */
function isComparison(value: unknown): value is Comparison {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    ['lte', 'lt', 'gt', 'not'].some((key) => key in value)
  );
}

function passt(row: object, wo: WoId): boolean {
  const fields = row as Record<string, unknown>;
  return Object.entries(wo).every(([field, value]) => {
    // `OR` ist kein Feld, sondern eine Verknüpfung — mindestens ein Zweig muss
    // passen (benutzt für „Nutzername ODER E-Mail" und für die Bedingung der
    // 60-Sekunden-Sperre).
    if (field === 'OR') {
      const branches = value as WoId[];
      return branches.some((branch) => passt(row, branch));
    }
    // `AND` verknüpft Teilbedingungen; ein leeres Objekt darin passt immer
    // (so schaltet die Anwendung eine Bedingung fallweise ab).
    if (field === 'AND') {
      const branches = value as WoId[];
      return branches.every((branch) => passt(row, branch));
    }
    if (isComparison(value)) {
      const present = fields[field];
      if ('not' in value && value.not === null) return present !== null;
      if (value.lt !== undefined) {
        return typeof present === 'number' && present < value.lt;
      }
      if (value.lte !== undefined) {
        return (
          present instanceof Date &&
          present.getTime() <= value.lte.getTime()
        );
      }
      if (value.gt !== undefined) {
        return (
          present instanceof Date && present.getTime() > value.gt.getTime()
        );
      }
      return false;
    }
    if (value === null) return fields[field] === null;
    if (value instanceof Date) {
      const present = fields[field];
      return present instanceof Date && present.getTime() === value.getTime();
    }
    return fields[field] === value;
  });
}

/**
 * Bildet Prismas `{ increment: n }` nach; alles andere wird zugewiesen.
 * In Postgres ist `increment` ein `SET x = x + n` und damit atomar — hier ist
 * es nur eine Addition. Die Atomarität weisen die Integrationsläufe nach.
 */
function applyWithIncrement(
  row: object,
  store: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(store)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      'increment' in (value as Record<string, unknown>)
    ) {
      const um = (value as { increment: number }).increment;
      const fields = row as unknown as Record<string, number>;
      fields[field] = (fields[field] ?? 0) + um;
    } else {
      (row as Record<string, unknown>)[field] = value;
    }
  }
}

function apply(row: object, store: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(store)) {
    (row as Record<string, unknown>)[field] = value;
  }
}

/** Erzeugt einen Prisma-Ersatz samt Zugriff auf die zugrunde liegenden Daten. */
export function buildDouble(start: Partial<DoubleData> = {}): {
  prisma: PrismaService;
  store: DoubleData;
} {
  const store: DoubleData = {
    user: start.user ?? [],
    codes: start.codes ?? [],
    emailCodes: start.emailCodes ?? [],
    devices: start.devices ?? [],
    passkeys: start.passkeys ?? [],
    emergency: start.emergency ?? [],
    audit: start.audit ?? [],
  };

  const double = {
    user: {
      findUnique: async ({ where }: { where: WoId }) =>
        store.user.find((row) => passt(row, where)) ?? null,
      findFirst: async ({ where }: { where: WoId }) =>
        store.user.find((row) => passt(row, where)) ?? null,
      findMany: async ({ take }: { take?: number } = {}) =>
        take ? store.user.slice(0, take) : [...store.user],
      update: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const row = store.user.find((entry) => passt(entry, where));
        if (!row) throw new Error('Benutzer nicht gefunden.');
        applyWithIncrement(row, data);
        return row;
      },
      /**
       * Bedingtes UPDATE auf die Benutzerzeile. `TotpService.bestaetige`
       * übernimmt das vorläufige Geheimnis nur, solange es noch DASSELBE ist —
       * eine zweite Einrichtung soll den überholten Vorgang leerlaufen lassen.
       */
      updateMany: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const hit = store.user.filter((row) => passt(row, where));
        hit.forEach((row) => applyWithIncrement(row, data));
        return { count: hit.length };
      },
    },

    recoveryCode: {
      findMany: async ({ where }: { where: WoId }) =>
        store.codes.filter((row) => passt(row, where)),
      count: async ({ where }: { where: WoId }) =>
        store.codes.filter((row) => passt(row, where)).length,
      deleteMany: async ({ where }: { where: WoId }) => {
        const keep = store.codes.filter((row) => !passt(row, where));
        const count = store.codes.length - keep.length;
        store.codes.splice(0, store.codes.length, ...keep);
        return { count: count };
      },
      createMany: async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
        for (const entry of data) {
          store.codes.push({
            id: randomUUID(),
            userId: entry.userId,
            codeHash: entry.codeHash,
            createdAt: new Date(),
            consumedAt: null,
          });
        }
        return { count: data.length };
      },
      // Bedingtes UPDATE — der Kern der Einmaligkeitsprüfung. Bewusst
      // synchron über den gesamten Vorgang, wie ein einzelnes SQL-UPDATE.
      updateMany: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const hit = store.codes.filter((row) => passt(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      },
    },

    emailLoginCode: {
      findMany: async ({ where }: { where: WoId }) =>
        store.emailCodes.filter((row) => passt(row, where)),
      findFirst: async ({ where }: { where: WoId }) =>
        store.emailCodes.find((row) => passt(row, where)) ?? null,
      /**
       * Bildet `@@unique([benutzerId])` nach: ein zweiter Code für denselben
       * Benutzer scheitert mit `P2002`, genau wie in Postgres. Ohne das würde
       * der Ausweichpfad in `fordereAn` im Test nie durchlaufen.
       */
      create: async ({
        data,
      }: {
        data: Omit<
          EmailCodeRow,
          'id' | 'failedAttempts' | 'consumedAt' | 'createdAt'
        > & { createdAt?: Date; failedAttempts?: number; consumedAt?: Date | null };
      }) => {
        if (store.emailCodes.some((row) => row.userId === data.userId)) {
          const error = new Error(
            'Unique constraint failed on the fields: (`benutzerId`)',
          ) as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        const row: EmailCodeRow = {
          id: randomUUID(),
          failedAttempts: 0,
          consumedAt: null,
          createdAt: new Date(),
          ...data,
        };
        store.emailCodes.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: WoId }) => {
        const keep = store.emailCodes.filter((row) => !passt(row, where));
        const count = store.emailCodes.length - keep.length;
        store.emailCodes.splice(0, store.emailCodes.length, ...keep);
        return { count: count };
      },
      /**
       * Bildet `data: { fehlversuche: { increment: 1 } }` nach — in Postgres ein
       * `SET fehlversuche = fehlversuche + 1` und damit atomar. Hier ist es nur
       * eine Addition; die Atomarität weist erst der Integrationslauf nach.
       */
      update: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const row = store.emailCodes.find((entry) => passt(entry, where));
        if (!row) throw new Error('Anmeldecode nicht gefunden.');
        applyWithIncrement(row, data);
        return row;
      },
      // Bedingtes UPDATE — die Einmaligkeit des Codes hängt daran.
      updateMany: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const hit = store.emailCodes.filter((row) => passt(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      },
    },

    device: {
      create: async ({ data }: { data: Omit<DeviceRow, 'id'> }) => {
        const row: DeviceRow = { id: randomUUID(), ...data };
        store.devices.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: WoId }) =>
        store.devices.find((row) => passt(row, where)) ?? null,
      findMany: async ({ where }: { where: WoId }) =>
        store.devices.filter((row) => passt(row, where)),
      update: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const row = store.devices.find((entry) => passt(entry, where));
        if (!row) throw new Error('Gerät nicht gefunden.');
        apply(row, data);
        return row;
      },
      delete: async ({ where }: { where: WoId }) => {
        const index = store.devices.findIndex((row) => passt(row, where));
        if (index < 0) throw new Error('Gerät nicht gefunden.');
        return store.devices.splice(index, 1)[0];
      },
      deleteMany: async ({ where }: { where: WoId }) => {
        const keep = store.devices.filter((row) => !passt(row, where));
        const count = store.devices.length - keep.length;
        store.devices.splice(0, store.devices.length, ...keep);
        return { count: count };
      },
    },

    passkeyCredential: {
      count: async ({ where }: { where: WoId }) =>
        store.passkeys.filter((row) => passt(row, where)).length,
      findMany: async ({ where }: { where: WoId }) =>
        store.passkeys.filter((row) => passt(row, where)),
      findUnique: async ({ where }: { where: WoId }) =>
        store.passkeys.find((row) => passt(row, where)) ?? null,
      create: async ({ data }: { data: Omit<PasskeyRow, 'id' | 'createdAt' | 'lastUsedAt'> }) => {
        const row: PasskeyRow = {
          id: randomUUID(),
          createdAt: new Date(),
          lastUsedAt: null,
          ...data,
        };
        store.passkeys.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const row = store.passkeys.find((entry) => passt(entry, where));
        if (!row) throw new Error('Passkey nicht gefunden.');
        apply(row, data);
        return row;
      },
      delete: async ({ where }: { where: WoId }) => {
        const index = store.passkeys.findIndex((row) => passt(row, where));
        if (index < 0) throw new Error('Passkey nicht gefunden.');
        return store.passkeys.splice(index, 1)[0];
      },
      deleteMany: async ({ where }: { where: WoId }) => {
        const keep = store.passkeys.filter((row) => !passt(row, where));
        const count = store.passkeys.length - keep.length;
        store.passkeys.splice(0, store.passkeys.length, ...keep);
        return { count: count };
      },
    },

    emergencyEnrollment: {
      create: async ({ data }: { data: Omit<EmergencyRow, 'id' | 'redeemedAt'> }) => {
        const row: EmergencyRow = {
          id: randomUUID(),
          redeemedAt: null,
          ...data,
        };
        store.emergency.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: WoId }) => {
        const row = store.emergency.find((entry) => passt(entry, where));
        if (!row) return null;
        const user = store.user.find((b) => b.id === row.userId);
        return { ...row, user: user ?? null };
      },
      // Bedingtes UPDATE — verhindert die doppelte Einlösung desselben Links.
      updateMany: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const hit = store.emergency.filter((row) => passt(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      },
      // Rücknahme einer Reservierung, wenn die nachgelagerte Prüfung scheitert.
      update: async ({
        where,
        data,
      }: {
        where: WoId;
        data: Record<string, unknown>;
      }) => {
        const row = store.emergency.find((entry) => passt(entry, where));
        if (!row) throw new Error('Notfall-Eintrag nicht gefunden.');
        apply(row, data);
        return row;
      },
    },

    auditLog: {
      create: async ({ data }: { data: Omit<AuditRow, 'id' | 'timestamp'> }) => {
        const row: AuditRow = {
          id: randomUUID(),
          timestamp: new Date(),
          ...data,
        };
        store.audit.push(row);
        return row;
      },
    },

    /**
     * Bildet das eine rohe SQL-Statement nach, das die Anwendung benutzt:
     * das atomare Hochzählen der Fehlversuche in `sperre.service.ts`.
     *
     * ACHTUNG: Diese Attrappe belegt NICHT die Atomarität — JavaScript ist
     * einfädig, hier kann es gar kein Rennen geben. Dass gleichzeitige
     * Anfragen wirklich serialisiert werden, weist ausschließlich
     * `sperre.integration.spec.ts` gegen eine echte Postgres-Datenbank nach.
     * Hier geht es nur darum, dass die übrigen Tests weiterlaufen.
     */
    $queryRaw: async (
      parts: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ failedAttempts: number; lockedUntil: Date | null }[]> => {
      // Der Zeilen-Lock aus `entferneFaktorAtomar`. In Postgres serialisiert er
      // alle Faktoränderungen eines Kontos; hier ist er wirkungslos, weil
      // JavaScript einfädig ist und es gar kein Rennen geben kann. Dass die
      // Sperre wirklich greift, weist ausschließlich
      // `faktoren.integration.spec.ts` gegen eine echte Datenbank nach.
      const sql = parts.join('?');
      if (sql.includes('FOR UPDATE')) {
        return [];
      }
      // Das Statement muss gegen die ECHTEN Spaltennamen des Prisma-Schemas
      // geschrieben sein. Ein Tippfehler dort (Spalte existiert nicht) wäre in
      // Postgres ein 500 bei jedem Fehlversuch und die Sperre griffe nie.
      assertColumns(sql);
      // Reihenfolge der Parameter im Statement:
      // jetzt, jetzt, MAX_FEHLVERSUCHE, sperrende, benutzerId
      const [now, , max, locking, userId] = values as [
        Date,
        Date,
        number,
        Date,
        string,
      ];
      const row = store.user.find((entry) => entry.id === userId);
      if (!row) return [];

      const expired =
        row.lockedUntil !== null &&
        row.lockedUntil.getTime() <= now.getTime();
      row.failedAttempts = expired ? 1 : row.failedAttempts + 1;
      row.lockedUntil = row.failedAttempts >= max ? locking : null;
      return [
        { failedAttempts: row.failedAttempts, lockedUntil: row.lockedUntil },
      ];
    },

    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> =>
      work(double),
  };

  return { prisma: double as unknown as PrismaService, store };
}

const USER_COLUMNS = new Set([
  'id',
  'failedAttempts',
  'lockedUntil',
]);

/** Prüft, dass jeder in doppelten Anführungszeichen genannte Bezeichner im
 *  Roh-SQL für `User` eine echte Spalte (oder die Tabelle selbst) ist. */
function assertColumns(sql: string): void {
  for (const match of sql.matchAll(/"([A-Za-z_]+)"/g)) {
    const name = match[1];
    if (name === 'User') continue;
    if (!USER_COLUMNS.has(name)) {
      throw new Error(`column "${name}" of relation "User" does not exist`);
    }
  }
}
