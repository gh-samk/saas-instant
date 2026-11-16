import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  emptyIssuerProfile,
  validateAccentColor,
  validateIssuerProfile,
  LEGAL_FORMS,
  type IssuerIssue,
  type IssuerProfile,
  type LegalForm,
} from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/session.service';
import { BusinessError } from '../common/errors/business-error';
import type { InquirySource } from '../common/inquiry-source';
import {
  IssuerConfigService,
  type IssuerProfileSource,
} from '../invoices/document/issuer.config';
import {
  currentFromProfile,
  profileFromIssuer,
  type CurrentIssuer,
} from '../invoices/document/issuer-mapping';
import { ManifestService } from '../manifest/manifest.service';
import { PrismaService } from '../prisma/prisma.service';

export const LOGO_MAX_BYTES = 512 * 1024;
const ID = 'singleton';

export type LogoMime = 'image/png' | 'image/jpeg';

/** Die Akzentfarbe ist unbrauchbar (Format oder Kontrast), mit Grund. */
export class AccentColorInvalidError extends BusinessError {
  constructor(reason: 'format' | 'contrast', contrastOnWhite?: number) {
    super(
      'accent_color_invalid',
      reason === 'format'
        ? 'Die Akzentfarbe muss im Format #rrggbb angegeben werden.'
        : 'Die Akzentfarbe hat auf weißem Papier zu wenig Kontrast (mindestens 4,5:1).',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { reason, ...(contrastOnWhite !== undefined ? { contrastOnWhite } : {}) },
    );
  }
}

/** Das Logo ist kein zulässiges PNG/JPEG oder zu groß. */
export class LogoInvalidError extends BusinessError {
  constructor(reason: 'type' | 'too_large' | 'empty' | 'mismatch') {
    const messages = {
      type: 'Das Logo muss ein PNG oder JPEG sein.',
      too_large: `Das Logo darf höchstens ${LOGO_MAX_BYTES / 1024} KB groß sein.`,
      empty: 'Es wurde keine Bilddatei übermittelt.',
      mismatch: 'Der Dateityp stimmt nicht mit dem Inhalt der Datei überein.',
    } as const;
    super(
      'logo_invalid',
      messages[reason],
      reason === 'too_large'
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      { reason },
    );
  }
}

/** Ermittelt den Typ aus den ersten Bytes — nie aus dem Dateinamen. */
export function sniffLogo(data: Buffer): LogoMime | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export interface LogoMeta {
  hasLogo: boolean;
  mime: LogoMime | null;
  sha256: string | null;
  sizeBytes: number | null;
}

export interface StoredIssuer {
  profile: IssuerProfile;
  accentColor: string | null;
  logo: LogoMeta;
  updatedAt: string | null;
}

export interface IssuerResponse extends StoredIssuer {
  accentOnDark: string | null;
  /** Fehlende bzw. fehlerhafte Pflichtangaben für die gewählte Rechtsform. */
  missing: IssuerIssue[];
}

/** Ein gespeichertes JSON zu einem vollständigen Profil ergänzen (Vorwärtskompatibilität). */
export function normalizeProfile(raw: unknown): IssuerProfile {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const form = (
    typeof obj['legalForm'] === 'string' && obj['legalForm'] in LEGAL_FORMS
      ? obj['legalForm']
      : 'einzelunternehmen'
  ) as LegalForm;
  const base = emptyIssuerProfile(form);
  const gp = (
    obj['generalPartner'] && typeof obj['generalPartner'] === 'object'
      ? obj['generalPartner']
      : {}
  ) as Record<string, unknown>;
  // Nur bekannte Felder übernehmen: Altfelder im gespeicherten JSON werden ignoriert.
  const known = (src: Record<string, unknown>, shape: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(src).filter(([k]) => k in shape));
  return {
    ...base,
    ...(known(obj, base) as Partial<IssuerProfile>),
    legalForm: form,
    generalPartner: { ...base.generalPartner, ...known(gp, base.generalPartner) },
  };
}

/**
 * Firmendaten (Rechnungsaussteller) — eine Zeile, `id = 'singleton'`.
 *
 * Beim ersten Zugriff ohne Zeile wird das Profil einmalig aus Manifest und
 * Umgebung befüllt (`IssuerConfigService.read`); danach gilt nur noch die
 * Datenbank.
 */
@Injectable()
export class IssuerProfileService implements IssuerProfileSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Optional() private readonly manifest?: ManifestService,
  ) {}

  private async ensureRow(): Promise<void> {
    const exists = await this.prisma.issuerProfile.findUnique({
      where: { id: ID },
      select: { id: true },
    });
    if (exists) return;
    const startup = new IssuerConfigService(this.config, this.manifest).read();
    const profile = profileFromIssuer(startup);
    try {
      await this.prisma.issuerProfile.create({
        data: { id: ID, data: profile as unknown as object },
      });
    } catch (e) {
      // Eine zweite Instanz war schneller: dann gilt deren Zeile.
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }

  async get(): Promise<StoredIssuer> {
    await this.ensureRow();
    const row = await this.prisma.issuerProfile.findUniqueOrThrow({
      where: { id: ID },
      select: {
        data: true,
        accentColor: true,
        logoMime: true,
        logoSha256: true,
        updatedAt: true,
        logo: false,
      },
    });
    const size = row.logoSha256
      ? ((await this.prisma.$queryRaw<{ n: number }[]>`SELECT octet_length("logo")::int AS n FROM "IssuerProfile" WHERE id = ${ID}`)[0]?.n ?? null)
      : null;
    return {
      profile: normalizeProfile(row.data),
      accentColor: row.accentColor,
      logo: {
        hasLogo: row.logoSha256 !== null,
        mime: (row.logoMime as LogoMime | null) ?? null,
        sha256: row.logoSha256,
        sizeBytes: size,
      },
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getResponse(): Promise<IssuerResponse> {
    return this.toResponse(await this.get());
  }

  private toResponse(s: StoredIssuer): IssuerResponse {
    return {
      ...s,
      accentOnDark:
        s.accentColor !== null
          ? (validateAccentColor(s.accentColor).accentOnDark ?? null)
          : null,
      missing: validateIssuerProfile(s.profile),
    };
  }

  /** Aussteller, Profil, Logo (als data:-URI) und Farbe — für Festschreiben und Dokumente. */
  async currentIssuer(): Promise<CurrentIssuer> {
    await this.ensureRow();
    const row = await this.prisma.issuerProfile.findUniqueOrThrow({
      where: { id: ID },
    });
    const logo =
      row.logo && row.logoMime
        ? `data:${row.logoMime};base64,${Buffer.from(row.logo).toString('base64')}`
        : null;
    return currentFromProfile(normalizeProfile(row.data), row.accentColor, logo);
  }

  /** Nur was die öffentliche Konfiguration braucht; legt nichts an. */
  async branding(): Promise<{
    accentColor: string | null;
    accentOnDark: string | null;
    hasLogo: boolean;
  }> {
    const row = await this.prisma.issuerProfile.findUnique({
      where: { id: ID },
      select: { accentColor: true, logoSha256: true },
    });
    const accent = row?.accentColor ?? null;
    const check = accent !== null ? validateAccentColor(accent) : null;
    return {
      accentColor: check?.valid ? accent : null,
      accentOnDark: check?.valid ? (check.accentOnDark ?? null) : null,
      hasLogo: (row?.logoSha256 ?? null) !== null,
    };
  }

  /** Entwurf speichern: auch unvollständig. Akzentfarbe wird streng geprüft. */
  async update(
    profile: IssuerProfile,
    accentColor: string | null,
    user: Pick<SessionUser, 'id' | 'username'>,
    source: InquirySource,
  ): Promise<IssuerResponse> {
    let accent: string | null = null;
    if (accentColor !== null && accentColor !== '') {
      const check = validateAccentColor(accentColor);
      if (!check.valid) {
        throw new AccentColorInvalidError(
          check.error ?? 'format',
          check.contrastOnWhite,
        );
      }
      accent = accentColor.toLowerCase();
    }
    await this.ensureRow();
    const before = await this.get();
    const after = normalizeProfile(profile);
    await this.prisma.$transaction(async (tx) => {
      await tx.issuerProfile.update({
        where: { id: ID },
        data: {
          data: after as unknown as object,
          accentColor: accent,
          updatedBy: user.id,
        },
      });
      await this.audit.log(
        {
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.issuerUpdated,
          objectType: 'IssuerProfile',
          objectId: ID,
          beforeValue: this.summary(before.profile, before.accentColor),
          afterValue: this.summary(after, accent),
          ip: source.ip,
          userAgent: source.userAgent,
        },
        tx,
      );
    });
    return this.getResponse();
  }

  /** Nur Rechtsform und Namen der geänderten Felder — nie die Inhalte. */
  private summary(
    p: IssuerProfile,
    accent: string | null,
  ): Record<string, unknown> {
    const flat = (v: unknown): string => JSON.stringify(v);
    const empty = emptyIssuerProfile(p.legalForm);
    const filled = Object.keys(p).filter(
      (k) => flat(p[k as keyof IssuerProfile]) !== flat(empty[k as keyof IssuerProfile]),
    );
    return { legalForm: p.legalForm, filledFields: filled, accentColor: accent };
  }

  async setLogo(
    data: Buffer,
    declaredMime: string | undefined,
    user: Pick<SessionUser, 'id' | 'username'>,
    source: InquirySource,
  ): Promise<IssuerResponse> {
    if (data.length === 0) throw new LogoInvalidError('empty');
    if (data.length > LOGO_MAX_BYTES) throw new LogoInvalidError('too_large');
    const mime = sniffLogo(data);
    if (mime === null) throw new LogoInvalidError('type');
    if (declaredMime !== undefined && declaredMime.split(';')[0]!.trim() !== mime) {
      throw new LogoInvalidError('mismatch');
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    await this.ensureRow();
    await this.prisma.$transaction(async (tx) => {
      await tx.issuerProfile.update({
        where: { id: ID },
        data: { logo: data, logoMime: mime, logoSha256: sha256, updatedBy: user.id },
      });
      await this.audit.log(
        {
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.issuerUpdated,
          objectType: 'IssuerProfile',
          objectId: ID,
          afterValue: { logo: 'set', mime, sha256, sizeBytes: data.length },
          ip: source.ip,
          userAgent: source.userAgent,
        },
        tx,
      );
    });
    return this.getResponse();
  }

  async deleteLogo(
    user: Pick<SessionUser, 'id' | 'username'>,
    source: InquirySource,
  ): Promise<IssuerResponse> {
    await this.ensureRow();
    await this.prisma.$transaction(async (tx) => {
      await tx.issuerProfile.update({
        where: { id: ID },
        data: { logo: null, logoMime: null, logoSha256: null, updatedBy: user.id },
      });
      await this.audit.log(
        {
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.issuerUpdated,
          objectType: 'IssuerProfile',
          objectId: ID,
          afterValue: { logo: 'removed' },
          ip: source.ip,
          userAgent: source.userAgent,
        },
        tx,
      );
    });
    return this.getResponse();
  }

  /** Die Logo-Bytes für die öffentliche Auslieferung. */
  async logoFile(): Promise<{ data: Buffer; mime: LogoMime; sha256: string } | null> {
    const row = await this.prisma.issuerProfile.findUnique({
      where: { id: ID },
      select: { logo: true, logoMime: true, logoSha256: true },
    });
    if (!row?.logo || !row.logoMime || !row.logoSha256) return null;
    return {
      data: Buffer.from(row.logo),
      mime: row.logoMime as LogoMime,
      sha256: row.logoSha256,
    };
  }
}
