import { Injectable } from '@nestjs/common';
import { today } from '@saas-instant/shared';
import { TasksService } from '../tasks/tasks.service';
import { sum, paymentStateFrom } from '../invoices/invoice.response';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Die zwei Zahlen, die in der Navigation stehen dürfen.
 *
 * WARUM NUR ZWEI. Das Design ist an dieser Stelle ausdrücklich: In die
 * Seitenleiste gehören Zähler NUR bei Handlungsbedarf — rot für das, was
 * heute ansteht, bernstein für offene Rechnungen. Reine Mengenangaben („94
 * Organisationen") gehören nicht dorthin: Sie ändern sich ständig, niemand
 * handelt danach, und eine Leiste voller Zahlen macht die beiden wichtigen
 * unsichtbar.
 *
 * SIE SIND EINE MOMENTAUFNAHME, kein Abonnement. Der Rahmen holt sie einmal
 * beim Betreten und danach, wenn sich etwas geändert haben könnte. Ein Zähler,
 * der ein paar Minuten nachhinkt, ist harmlos; ein Zähler, der bei jedem
 * Seitenwechsel neu rechnet, kostet bei jeder Navigation eine Runde durch
 * sämtliche Aufgabenquellen.
 */

export interface NavigationCounter {
  /** Aufgaben, die heute oder früher fällig sind. */
  tasksUrgent: number;
  /** Festgeschriebene Rechnungen, die noch nicht bezahlt sind. */
  invoicesOpen: number;
}

@Injectable()
export class NavigationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  async count(): Promise<NavigationCounter> {
    const [tasksUrgent, invoicesOpen] = await Promise.all([
      this.urgentTasks(),
      this.openInvoices(),
    ]);
    return { tasksUrgent, invoicesOpen };
  }

  /**
   * „Dringend" ist genau das, was die Aufgabenliste selbst so nennt: fällig
   * heute oder früher (`dringlichkeitAus`). Die Zahl wird NICHT hier neu
   * gerechnet — sie kommt aus derselben Quelle wie die Liste, damit Zähler
   * und Liste nicht auseinanderlaufen können.
   */
  private async urgentTasks(): Promise<number> {
    const { tasks } = await this.tasks.collect();
    return tasks.filter((a) => a.urgency === 'high').length;
  }

  /**
   * Offen heisst: festgeschrieben oder versendet und nicht ausgeglichen.
   *
   * Der Zustand steht nirgends als Spalte — er wird aus Fälligkeit und
   * gezahltem Betrag abgeleitet (`zahlungsstandVon`). Deshalb wird hier
   * gelesen und gezählt statt in SQL gefiltert: Eine zweite Fassung dieser
   * Ableitung wäre die Stelle, an der Zähler und Liste eines Tages
   * verschiedene Zahlen zeigen.
   *
   * Entwürfe und Stornos zählen nicht mit — ein Entwurf fordert kein Geld,
   * und eine stornierte Rechnung fordert keines mehr.
   */
  private async openInvoices(): Promise<number> {
    const lines = await this.prisma.invoice.findMany({
      where: { status: { notIn: ['draft', 'cancelled'] } },
      select: {
        status: true,
        dueDate: true,
        paidAmount: true,
        cancelledInvoiceId: true,
        lines: { select: { grossAmount: true } },
      },
    });
    const todayDay = today();
    return lines.filter((line) => {
      const state = paymentStateFrom(line, sum(line.lines, 'grossAmount'), todayDay);
      return state === 'open' || state === 'overdue';
    }).length;
  }
}
