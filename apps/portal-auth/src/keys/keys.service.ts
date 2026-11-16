import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KeyLike, JWK, exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { randomBytes } from 'crypto';
import { FieldCrypto } from '../common/field-crypto';
import { CONFIG, PortalConfig } from '../config';
import { PrismaService } from '../prisma.service';

/** Lebensdauer eines ID-Tokens. */
export const ID_TOKEN_TTL_SECONDS = 5 * 60;
/** Ein ausgemusterter Schlüssel bleibt noch so lange im JWKS: Token-Lebensdauer plus Puffer. */
export const RETIRED_KEY_GRACE_MS = (ID_TOKEN_TTL_SECONDS + 10 * 60) * 1000;

interface ActiveSigner {
  kid: string;
  key: KeyLike;
}

/** Ed25519-Signaturschlüssel: beim ersten Start erzeugt, privat verschlüsselt in der DB. */
@Injectable()
export class KeysService implements OnModuleInit {
  private readonly logger = new Logger(KeysService.name);
  private readonly crypto: FieldCrypto;
  private cache: ActiveSigner | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) config: PortalConfig,
  ) {
    this.crypto = new FieldCrypto(config.keySecret);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureActiveKey();
  }

  /** Erzeugt den ersten Schlüssel, falls noch keiner aktiv ist. */
  async ensureActiveKey(): Promise<void> {
    const active = await this.prisma.signingKey.findFirst({ where: { retiredAt: null } });
    if (!active) {
      const kid = await this.createKey();
      this.logger.log(`Ersten Signaturschlüssel erzeugt (kid ${kid}).`);
    }
  }

  private async createKey(): Promise<string> {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const kid = randomBytes(12).toString('base64url');
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
    const pem = await exportPKCS8(privateKey);
    await this.prisma.signingKey.create({
      data: { kid, publicJwk: publicJwk as object, privateEnc: this.crypto.encrypt(pem) },
    });
    return kid;
  }

  /**
   * Rotation: der aktive Schlüssel hört auf zu signieren, bleibt aber bis zum
   * Ablauf im JWKS; ein neuer wird aktiv.
   */
  async rotate(now: Date = new Date()): Promise<{ newKid: string; retiredKids: string[] }> {
    const old = await this.prisma.signingKey.findMany({ where: { retiredAt: null } });
    const newKid = await this.createKey();
    for (const key of old) {
      await this.prisma.signingKey.update({
        where: { kid: key.kid },
        data: { retiredAt: now, expiresAt: new Date(now.getTime() + RETIRED_KEY_GRACE_MS) },
      });
    }
    this.cache = null;
    return { newKid, retiredKids: old.map((k) => k.kid) };
  }

  /** Der signierende Schlüssel (der jüngste, nicht ausgemusterte). */
  async signer(): Promise<ActiveSigner> {
    const row = await this.prisma.signingKey.findFirst({
      where: { retiredAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      await this.ensureActiveKey();
      return this.signer();
    }
    if (this.cache?.kid === row.kid) return this.cache;
    const key = await importPKCS8(this.crypto.decrypt(row.privateEnc), 'EdDSA');
    this.cache = { kid: row.kid, key };
    return this.cache;
  }

  /** Öffentliche Schlüssel: der aktive und ausgemusterte bis zu ihrem Ablauf. */
  async jwks(now: Date = new Date()): Promise<{ keys: JWK[] }> {
    const rows = await this.prisma.signingKey.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: 'desc' },
    });
    return { keys: rows.map((row) => row.publicJwk as unknown as JWK) };
  }

  async signIdToken(claims: Record<string, unknown>, issuer: string, audience: string, now: Date = new Date()): Promise<string> {
    const { kid, key } = await this.signer();
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ID_TOKEN_TTL_SECONDS)
      .sign(key);
  }
}
