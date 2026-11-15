import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '.prisma/control-client';

/**
 * PrismaClient von saas-instant Control als injizierbarer NestJS-Service.
 *
 * Der Client wird bewusst aus einem EIGENEN Generat (`.prisma/control-client`)
 * geladen: `apps/api` und `apps/control` teilen sich im pnpm-Store dasselbe
 * `@prisma/client`-Paket und würden sich sonst gegenseitig den generierten
 * Standard-Client überschreiben.
 *
 * Es gibt genau EINE Datenbankverbindung (DATABASE_URL auf `saas_instant_control`).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
