import { Injectable, Logger } from '@nestjs/common';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackupDateInFutureError } from './instance.errors';
import { FUTURE_TOLERANCE_DAYS } from '../common/validators/is-past-day';
import type { BackupReportDto } from './dto/instance.dto';

/**
 * Nimmt die Meldung einer GELUNGENEN Sicherung entgegen.
 *
 * WARUM MELDUNG STATT ABFRAGE: Die Sicherungen laufen ausserhalb dieses
 * Systems (Coolify-Backup, Ziel externer Speicher). Das CRM hat keinen Zugang
 * dorthin und soll auch keinen bekommen — es würde bedeuten, dass ein
 * kompromittiertes CRM an die Sicherungen aller Kunden käme. Das
 * Sicherungswerkzeug meldet stattdessen nach jedem erfolgreichen Lauf eine
 * Zeile; ihr AUSBLEIBEN ist das Signal, das die Aufgabenquelle
 * `backup_ausgeblieben` auswertet.
 *
 * DIESER DIENST LEGT AN UND BERICHTIGT. Er löscht nichts und spielt nichts
 * zurück (R1, R4, E3-15).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async report(dto: BackupReportDto, ip: string | null): Promise<{ ok: true }> {
    // ZWEITE VERTEIDIGUNGSLINIE hinter dem DTO-Validator ([K3]). Doppelt
    // geprüft, weil die Folge unumkehrbar ist: Eine Zeile mit Datum in der
    // Zukunft schaltet „Sicherung überfällig" für diese Instanz dauerhaft ab,
    // und einen Löschpfad für `Sicherung` gibt es bewusst nicht. Eine Prüfung,
    // die nur an der Pipe hängt, verschwindet mit dem nächsten Umbau, der den
    // Dienst von woanders aufruft.
    if (dto.date > datePlusDays(today(), FUTURE_TOLERANCE_DAYS)) {
      throw new BackupDateInFutureError(dto.date);
    }

    const kind = dto.kind ?? 'instance';
    const extra = {
      ...(dto.objectKey !== undefined ? { objectKey: dto.objectKey } : {}),
      ...(dto.sha256 !== undefined ? { sha256: dto.sha256.toLowerCase() } : {}),
    };

    if (kind !== 'instance') {
      // Verwaltungs-DB und Rechnungsarchiv hängen an keiner Instanz; die
      // Tabelle `Backup` kennt nur Instanz-Zeilen. Der Nachweis steht im Audit-Log.
      await this.audit.log({
        userId: null,
        actor: 'sicherungswerkzeug',
        action: AUDIT_ACTION.backupReported,
        objectType: 'Backup',
        objectId: null,
        afterValue: { kind, date: dto.date, sizeBytes: dto.sizeBytes, ...extra },
        ip,
      });
      return { ok: true };
    }

    const instance = await this.prisma.instance.findUnique({
      where: { subdomain: dto.subdomain ?? '' },
      select: { id: true },
    });
    if (instance === null) {
      // KEIN AUFZÄHLUNGSORAKEL ([H1]): Bekannte und unbekannte Subdomain
      // bekommen DIESELBE Antwort. Sonst liesse sich mit dem Schlüssel des
      // Sicherungswerkzeugs die vollständige Kundenliste abfragen, Subdomain
      // für Subdomain.
      //
      // Der Preis ist benannt: Ein Tippfehler im Skript fällt nicht hier auf,
      // sondern zwei Tage später an der Aufgabe „Sicherung überfällig" — an
      // der Stelle, an der jemand hinsieht. Und hier im Log.
      this.logger.warn(
        `Sicherungsmeldung für eine unbekannte Subdomain verworfen. Prüfe die ` +
          'Subdomain im Sicherungsskript; die Anwendung antwortet aus ' +
          'Sicherheitsgründen so, als wäre alles in Ordnung.',
      );
      return { ok: true };
    }

    const date = toDate(dto.date);
    const data = {
      sizeBytes: BigInt(dto.sizeBytes),
      ...extra,
      // Ein neues Objekt ist noch nicht geprüft.
      ...(dto.objectKey !== undefined ? { verifiedAt: null } : {}),
    };
    // Zweimal täglich gesichert, eine Zeile je Tag: der zweite Lauf
    // berichtigt die Zeile des ersten, statt die Historie zu verdoppeln.
    await this.prisma.backup.upsert({
      where: { instanceId_date: { instanceId: instance.id, date } },
      create: { instanceId: instance.id, date, ...data },
      update: data,
    });

    await this.audit.log({
      userId: null,
      actor: 'sicherungswerkzeug',
      action: AUDIT_ACTION.backupReported,
      objectType: 'Backup',
      objectId: instance.id,
      afterValue: {
        subdomain: dto.subdomain,
        date: dto.date,
        sizeBytes: dto.sizeBytes,
        ...extra,
      },
      ip,
    });
    return { ok: true };
  }
}
