import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { AuditService } from '../audit/audit.service';
import { LoginFlowService } from '../auth/login-flow.service';
import { LoginService } from '../auth/login.service';
import { EmailLoginCodeService } from '../auth/email-login-code.service';
import { DeviceService } from '../auth/device.service';
import { EmergencyService } from '../auth/emergency.service';
import type { PasskeyService } from '../auth/passkey.service';
import type { SessionService } from '../auth/session.service';
import { LockoutService } from '../auth/lockout.service';
import { TotpService } from '../auth/totp.service';
import { RecoveryCodeService } from '../auth/recovery-code.service';
import { AccessService } from '../auth/access.service';
import { CryptoService } from '../crypto/crypto.service';
import { MailService } from '../mail/mail.service';
import { buildUser, buildDouble } from './prisma-double';

/** Das Passwort, mit dem das Testkonto angelegt wird. */
export const TEST_PASSWORD = 'ein-hinreichend-langes-testpasswort';

const CONFIG: Record<string, string> = {
  CONTROL_CONFIG_KEY: 'testschluessel-mindestens-32-zeichen-lang',
  JWT_SECRET: 'testgeheimnis',
  CONTROL_APP_URL: 'http://localhost:5174',
};

/** ConfigService-Ersatz, der nur die im Test benötigten Schlüssel kennt. */
export function buildConfig(): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => CONFIG[key] ?? defaultValue,
  } as unknown as ConfigService;
}

/** Eine verschickte Mail, wie der Test sie sehen will. */
export interface SentMail {
  email: string;
  code: string;
  validMinutes: number;
  forSetup: boolean;
}

/**
 * Baut einen vollständig verdrahteten AnmeldungService gegen das In-Memory-
 * Doppel, samt Konto mit Passwort und eingerichtetem TOTP.
 *
 * Bewusst mit den ECHTEN Services für argon2, TOTP, E-Mail-Code, Sperre und
 * Audit — genau deren Zusammenspiel soll geprüft werden. Nur Sitzung, Passkey
 * und Mailversand sind Attrappen, weil sie hier nichts entscheiden.
 */
export async function buildLogin(
  userDefault: {
    loginCodeEnabled?: boolean;
    loginCodeEmail?: string | null;
  } = {},
) {
  const config = buildConfig();
  const crypto = new CryptoService(config);
  const secret = authenticator.generateSecret();
  const user = buildUser({
    passwordHash: await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }),
    totpSecret: crypto.encrypt(secret),
    loginCodeEnabled: userDefault.loginCodeEnabled ?? false,
    loginCodeEmail: userDefault.loginCodeEmail ?? null,
  });
  const { prisma, store: data } = buildDouble({ user: [user] });

  const audit = new AuditService(prisma);
  const lockout = new LockoutService(prisma, audit);
  const codes = new RecoveryCodeService(prisma);
  const codesByMail = new EmailLoginCodeService(prisma);

  /**
   * Mail-Attrappe. Merkt sich jede „verschickte" Mail samt Klartext-Code —
   * das ist die einzige Stelle, an der ein Test den Code je zu sehen bekommt,
   * genau wie in der Wirklichkeit das Postfach.
   */
  const mailbox: SentMail[] = [];
  const notes: { to: string; newAddress: string }[] = [];
  let sendFails = false;
  /**
   * Künstliche Versanddauer. Damit lässt sich prüfen, dass der SMTP-Roundtrip
   * die Antwortzeit NICHT mehr beeinflusst — der Kern von [K2]. Gegen die alte
   * Fassung, die den Versand abwartete, schlägt der Zeittest damit fehl.
   */
  let sendDurationMs = 0;
  const wait = (ms: number) =>
    new Promise((done) => setTimeout(done, ms));
  const mail = {
    sendLoginCode: async (
      email: string,
      code: string,
      validMinutes: number,
      forSetup: boolean,
    ) => {
      if (sendDurationMs > 0) await wait(sendDurationMs);
      if (sendFails) throw new Error('SMTP kaputt (Testfall).');
      mailbox.push({ email, code, validMinutes, forSetup });
    },
    sendAddressChangeNote: async (to: string, newAddress: string) => {
      if (sendDurationMs > 0) await wait(sendDurationMs);
      if (sendFails) throw new Error('SMTP kaputt (Testfall).');
      notes.push({ to, newAddress });
    },
  } as unknown as MailService;
  const devices = new DeviceService(prisma);
  const totp = new TotpService(prisma, crypto, config);
  const process = new LoginFlowService(
    new JwtService({ secret: CONFIG['JWT_SECRET'] }),
    config,
  );
  const session = {
    createToken: async () => 'sitzungs-jwt',
    // Zählt die Generation im Doppel hoch, damit Tests die Entwertung sehen.
    invalidateAllSessions: async (id: string) => {
      const row = data.user.find((entry) => entry.id === id);
      if (!row) throw new Error('Konto nicht gefunden.');
      row.sessionGeneration += 1;
      return row.sessionGeneration;
    },
  } as unknown as SessionService;
  /**
   * Schlanke Passkey-Attrappe. Die echte WebAuthn-Kryptographie gehört
   * @simplewebauthn und lässt sich ohne Browser nicht sinnvoll nachstellen;
   * geprüft wird hier nur, wie der AnmeldungService damit umgeht.
   */
  const passkey = {
    passkeysFrom: async (userId: string) =>
      data.passkeys.filter((row) => row.userId === userId),
    // Gibt IMMER dieselbe Antwortform zurück — egal ob das Konto bekannt,
    // unbekannt oder gesperrt ist. Genau das prüft der W7-Test.
    loginOptions: async (passkeys: { credentialId: string }[]) => ({
      challenge: 'test-challenge',
      rpId: 'localhost',
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: passkeys.map((entry) => ({ id: entry.credentialId })),
    }),
    findViaCredentialId: async (credentialId: string) =>
      data.passkeys.find((row) => row.credentialId === credentialId) ?? null,
    checkLogin: async () => false,
  } as unknown as PasskeyService;
  const emergency = new EmergencyService(prisma, config, audit, devices, session);

  const service = new LoginService(
    prisma,
    session,
    lockout,
    passkey,
    totp,
    codes,
    codesByMail,
    mail,
    devices,
    process,
    audit,
  );
  const access = new AccessService(
    prisma,
    passkey,
    totp,
    codes,
    codesByMail,
    mail,
    devices,
    process,
    session,
    lockout,
    audit,
  );

  /** Der angemeldete Benutzer, wie ihn der SitzungGuard liefern würde. */
  const sessionUser = {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role,
  };

  return {
    service,
    access,
    sessionUser,
    data,
    secret,
    codes,
    codesByMail,
    mailbox,
    /** Hinweismails an die BISHERIGE Zustelladresse ([W3]). */
    notes,
    /** Lässt den nächsten Mailversand scheitern (Testfall „SMTP kaputt"). */
    setSendBroken: (broken: boolean) => {
      sendFails = broken;
    },
    /** Verlangsamt den Mailversand künstlich (Zeitkanal-Prüfung, [K2]). */
    setSendDuration: (ms: number) => {
      sendDurationMs = ms;
    },
    /**
     * Wartet, bis der nebenläufige Versand durch ist. Nötig, weil
     * `fordereAnmeldecodeAn` den Versand bewusst NICHT mehr abwartet.
     */
    waitForSend: async () => {
      await wait(sendDurationMs + 30);
    },
    devices,
    lockout,
    emergency,
    totp,
    user,
  };
}

/** Aktueller gültiger TOTP-Code zum Geheimnis. */
export function totpCode(secret: string): string {
  return authenticator.generate(secret);
}
