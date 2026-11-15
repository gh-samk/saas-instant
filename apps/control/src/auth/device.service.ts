import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { TRUSTED_DEVICE_MAX_AGE_MS } from '../common/cookies';
import { PrismaService } from '../prisma/prisma.service';

/** Ein erkanntes Merk-Gerät samt frisch rotiertem Token. */
export interface RecognizedDevice {
  deviceId: string;
  userId: string;
  label: string;
  /** Neuer Klartext-Token; der alte ist ab sofort ungültig. */
  newToken: string;
}

/** Hasht den Merk-Token. Der Klartext existiert nur im Cookie des Geräts. */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Merk-Geräte für den TOTP-Pfad.
 *
 * Ein Merk-Gerät ersetzt AUSSCHLIESSLICH den zweiten Faktor auf dem
 * TOTP-Pfad — niemals die Anmeldung selbst. Ohne gültigen TOTP-Code führt ein
 * Merk-Gerät zu gar nichts.
 *
 * Gültigkeit 30 Tage, Rotation bei jeder Nutzung: ein abgegriffenes Cookie
 * verliert seinen Wert, sobald das echte Gerät sich das nächste Mal anmeldet.
 */
@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Legt ein Merk-Gerät an und gibt den Klartext-Token zurück. */
  async remember(
    userId: string,
    label: string,
    now: Date = new Date(),
  ): Promise<{ deviceId: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const device = await this.prisma.device.create({
      data: {
        userId,
        label,
        tokenHash: hash(token),
        createdAt: now,
        lastSeenAt: now,
        validUntil: new Date(now.getTime() + TRUSTED_DEVICE_MAX_AGE_MS),
      },
      select: { id: true },
    });
    return { deviceId: device.id, token };
  }

  /**
   * Erkennt ein Merk-Gerät anhand des Cookie-Tokens und rotiert es.
   * Liefert null, wenn der Token unbekannt, abgelaufen, widerrufen oder für
   * einen anderen Benutzer ausgestellt ist.
   */
  async recognizeAndRotate(
    token: string | undefined,
    userId: string,
    now: Date = new Date(),
  ): Promise<RecognizedDevice | null> {
    if (!token) return null;

    const device = await this.prisma.device.findUnique({
      where: { tokenHash: hash(token) },
      select: {
        id: true,
        userId: true,
        label: true,
        validUntil: true,
      },
    });
    if (!device) return null;
    if (device.userId !== userId) return null;
    if (device.validUntil.getTime() <= now.getTime()) return null;

    const newToken = randomBytes(32).toString('base64url');
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        tokenHash: hash(newToken),
        lastSeenAt: now,
        validUntil: new Date(now.getTime() + TRUSTED_DEVICE_MAX_AGE_MS),
      },
    });

    return {
      deviceId: device.id,
      userId: device.userId,
      label: device.label,
      newToken,
    };
  }

  /**
   * Widerruft ein einzelnes Gerät des Benutzers. Gibt die Bezeichnung zurück
   * oder null, wenn es dem Benutzer nicht gehört oder nicht existiert.
   */
  async revoke(userId: string, deviceId: string): Promise<string | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, userId: true, label: true },
    });
    if (!device || device.userId !== userId) return null;
    await this.prisma.device.delete({ where: { id: device.id } });
    return device.label;
  }

  /**
   * Entwertet ALLE Merk-Geräte eines Benutzers. Wird bei jeder Änderung an den
   * Passkeys erzwungen und von „alle Geräte abmelden" ausgelöst.
   */
  async revokeAll(userId: string): Promise<number> {
    const result = await this.prisma.device.deleteMany({ where: { userId } });
    return result.count;
  }

  /** Geräteliste für die Einstellungsseite. Ohne Token, ohne Hash. */
  async list(userId: string): Promise<
    {
      id: string;
      label: string;
      createdAt: Date;
      lastSeenAt: Date;
      validUntil: Date;
    }[]
  > {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastSeenAt: true,
        validUntil: true,
      },
    });
  }
}
