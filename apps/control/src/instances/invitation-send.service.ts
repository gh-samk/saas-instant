import { Injectable, Logger } from '@nestjs/common';
import { today } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { CoolifyConfigService, instanceHost } from '../coolify/coolify.config';
import { CryptoService } from '../crypto/crypto.service';
import { SETUP_SUBJECT, MailService } from '../mail/mail.service';
import { CompanyNotFoundError } from '../companies/company.errors';
import { PrismaService } from '../prisma/prisma.service';
import { invitationLinkFrom, toMetrics } from './instance.response';
import type { InstanceStatus } from './instance.types';

/** Was aus dem Versand des Einrichtungslinks wurde. */
export interface InvitationLinkSend {
  sent: boolean;
  /** Die Adresse, an die es ging oder gehen sollte — für die Rückmeldung. */
  email: string;
  reason?: 'no_address' | 'no_link' | 'send_failed';
}

/**
 * Was als Wortlaut in der Versandzeile steht — AUSDRÜCKLICH OHNE den Link.
 *
 * Der Link IST das Einrichtungsgeheimnis. Stünde er im Schnappschuss, läge er
 * im Klartext in einer Tabelle, die jede Datenbanksicherung mitnimmt — genau
 * das, was die Verschlüsselung von `setupTokenEncrypted` verhindern soll.
 * Dasselbe Vorgehen wie bei der Demo-Zugangsmail.
 */
export const SETUP_SNAPSHOT =
  'Standardtext „Einrichtungslink" mit kurzer Anleitung (der Link trägt das ' +
  'Einrichtungsgeheimnis der Instanz und wird hier nicht gespeichert).';

/**
 * ===========================================================================
 * DEN EINRICHTUNGSLINK PER MAIL VERSCHICKEN
 * ===========================================================================
 *
 * Bisher ging der Link nur über „anzeigen, kopieren, selbst verschicken". Das
 * hiess: Ein Zugang, mit dem man Administrator einer fremden Installation
 * wird, wanderte über die Zwischenablage in ein beliebiges Mailprogramm.
 *
 * NUR AN DIE HINTERLEGTE ANSPRECHPARTNERIN. Keine Adresse aus dem Aufruf —
 * wer sie mitschicken könnte, könnte den Link an sich selbst lenken.
 *
 * DERSELBE LINK WIE BEIM ANZEIGEN, dieselbe Regel (`invitationLinkFrom`). Ist
 * die Instanz schon eingerichtet, nicht aktiv oder ohne Geheimnis, geht keine
 * Mail hinaus — `kein_link` statt einer Mail, deren Link die Instanz mit 410
 * beantwortet.
 *
 * MELDET STATT ZU WERFEN, wie der Aufnahmelink: Die Oberfläche sagt, was
 * passiert ist, statt einen Fehlerdialog zu zeigen.
 */
@Injectable()
export class InvitationSendService {
  private readonly logger = new Logger(InvitationSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly coolifyConfig: CoolifyConfigService,
    private readonly mail: MailService,
  ) {}

  async send(
    companyId: string,
    actor: { name: string; userId: string | null },
    source: InquirySource,
  ): Promise<InvitationLinkSend> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        contactEmail: true,
        instance: {
          include: { metrics: { orderBy: { date: 'desc' }, take: 60 } },
        },
      },
    });
    if (!company) throw new CompanyNotFoundError();

    const target = (company.contactEmail ?? '').trim();
    if (target === '') return { sent: false, email: '', reason: 'no_address' };

    const instance = company.instance;
    if (instance === null) return { sent: false, email: target, reason: 'no_link' };

    const contract = this.coolifyConfig.contract();
    const status = instance.status as InstanceStatus;
    const link = invitationLinkFrom(
      status,
      status === 'active' ? toMetrics(instance.metrics, today()) : null,
      instance.subdomain,
      contract.baseDomain,
      this.decrypt(instance.setupTokenEncrypted, instance.subdomain),
      instance.setupCompletedAt !== null,
      contract.setupPath,
      contract.subdomainPattern,
    );
    if (link === null) return { sent: false, email: target, reason: 'no_link' };

    try {
      await this.mail.sendSetupLink(
        target,
        company.name,
        link,
        `https://${instanceHost(contract, instance.subdomain)}`,
      );
    } catch (error) {
      this.logger.error(
        `Einrichtungslink zu ${instance.subdomain} ging nicht hinaus: ` +
          `${error instanceof Error ? error.message : 'unbekannt'}.`,
      );
      return { sent: false, email: target, reason: 'send_failed' };
    }

    // ERST NACH DEM VERSAND — dieselbe Reihenfolge wie bei Rechnungen: Eine
    // Zeile „gesendet" für eine Mail, die nie hinausging, wäre ein falscher
    // Nachweis.
    await this.prisma.mailDelivery.create({
      data: {
        companyId,
        recipientAddress: target,
        channel: 'transactional',
        subject: SETUP_SUBJECT,
        contentSnapshot: SETUP_SNAPSHOT,
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.instanceInvitationLinkSent,
      objectType: 'Instance',
      objectId: instance.id,
      // Weder Link noch Adresse — siehe Kommentar an der Aktion.
      afterValue: { subdomain: instance.subdomain },
      ...source,
    });
    return { sent: true, email: target };
  }

  /** Wie `InstanceService.setupToken`: unlesbar heisst „kein Link", laut im Log. */
  private decrypt(encrypted: string | null, subdomain: string): string | null {
    if (encrypted === null) return null;
    try {
      return this.crypto.decrypt(encrypted);
    } catch {
      this.logger.error(
        `Einladungsgeheimnis von ${subdomain} ist nicht entschlüsselbar. ` +
          'Wurde CONTROL_CONFIG_KEY getauscht? Es geht keine Mail hinaus.',
      );
      return null;
    }
  }
}
