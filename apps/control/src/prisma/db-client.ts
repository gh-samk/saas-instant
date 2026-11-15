import type { Prisma, PrismaClient } from '.prisma/control-client';
import type { PrismaService } from './prisma.service';

/**
 * Prisma-Client ODER Transaktions-Client. Services akzeptieren diesen Typ,
 * damit sie an einer umschließenden interaktiven Transaktion teilnehmen können
 * (z. B. die atomare Entwertung eines Wiederherstellungscodes).
 */
export type DbClient = PrismaService | PrismaClient | Prisma.TransactionClient;
