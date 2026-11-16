import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '.prisma/portal-auth-client';
import { PrismaService } from '../prisma.service';

export interface AuditInput {
  action: string;
  accountId?: string | null;
  clientId?: string | null;
  ip?: string | null;
  detail?: Prisma.InputJsonValue;
}

/** Protokoll sicherheitsrelevanter Vorgänge. Ein Schreibfehler bricht die Anfrage nicht ab, wird aber laut gemeldet. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditInput): Promise<void> {
    try {
      await this.prisma.auditEntry.create({
        data: {
          action: entry.action,
          accountId: entry.accountId ?? null,
          clientId: entry.clientId ?? null,
          ip: entry.ip ?? null,
          detail: entry.detail ?? Prisma.JsonNull,
        },
      });
    } catch (error) {
      this.logger.error(`Audit-Eintrag "${entry.action}" nicht geschrieben: ${String(error)}`);
    }
  }
}
