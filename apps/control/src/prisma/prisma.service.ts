import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '.prisma/control-client';
import { withFieldEncryption } from './field-encryption';

/**
 * PrismaClient von saas-instant Control als injizierbarer NestJS-Service.
 *
 * Der Client wird bewusst aus einem EIGENEN Generat (`.prisma/control-client`)
 * geladen: `apps/api` und `apps/control` teilen sich im pnpm-Store dasselbe
 * `@prisma/client`-Paket und würden sich sonst gegenseitig den generierten
 * Standard-Client überschreiben.
 *
 * Es gibt genau EINE Datenbankverbindung (DATABASE_URL auf `saas_instant_control`).
 *
 * FELDVERSCHLÜSSELUNG: Der Konstruktor liefert den mit `withFieldEncryption`
 * erweiterten Client zurück. Alle Dienste sprechen also transparent mit
 * verschlüsselten Feldern (siehe `field-encryption.ts`). Den unerweiterten
 * Client gibt `rawClientOf(prisma)` heraus (nur für den Einmal-Lauf
 * `encrypt-existing`).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    // Der Rückgabewert ersetzt `this`; die Lebenszyklus-Haken unten erreicht
    // Nest über die Prototypkette des erweiterten Clients.
    return withFieldEncryption(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
