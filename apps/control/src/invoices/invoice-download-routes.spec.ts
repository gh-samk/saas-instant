import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { SessionGuard } from '../common/guards/session.guard';
import { InvoiceDocumentService, type DocumentFormat } from './document.service';
import { InvoiceNotFoundError } from './invoice.errors';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { PricingService } from './pricing.service';
import { IntegrityService } from './integrity.service';
import { InvoiceHistoryService } from './invoice-history.service';

/**
 * DIE DREI DOWNLOAD-ROUTEN — bisher ohne jeden Test.
 *
 * Gebaut wird der echte Controller in einer echten HTTP-Anwendung; ersetzt
 * werden nur der Dokumentdienst (Attrappe) und der SessionGuard (setzt einen
 * Benutzer). So wird geprüft, was am Draht ankommt: Pfad, Methode, Status,
 * Kopfzeilen, Bytes — und dass jede Route das RICHTIGE Format anfordert und
 * den Akteur samt Herkunft weitergibt (daraus entsteht das Abrufprotokoll
 * `invoice.document_downloaded`, siehe `document.service`).
 */

const USER = { id: 'user-1', username: 'sam' };

interface Call {
  format: DocumentFormat;
  id: string;
  actor: { userId: string | null; name: string };
  source: { ip?: string | null; userAgent?: string | null };
}

describe('Download-Routen einer Rechnung', () => {
  let app: INestApplication;
  let base: string;
  let calls: Call[];
  let allow = true;
  let failWith: Error | null = null;

  beforeAll(async () => {
    calls = [];
    const documents = {
      download: jest.fn(
        async (
          format: DocumentFormat,
          id: string,
          actor: Call['actor'],
          source: Call['source'],
        ) => {
          calls.push({ format, id, actor, source });
          if (failWith) throw failWith;
          if (format === 'pdf') {
            return {
              content: Buffer.from('%PDF-1.7 test'),
              filename: 'Rechnung-2026-001.pdf',
              contentType: 'application/pdf',
            };
          }
          return {
            content: Buffer.from(`<xml format="${format}"/>`),
            filename:
              format === 'xml'
                ? 'Rechnung-2026-001-factur-x.xml'
                : 'Rechnung-2026-001-xrechnung.xml',
            contentType: 'application/xml; charset=utf-8',
          };
        },
      ),
    };
    const module = await Test.createTestingModule({
      controllers: [InvoiceController],
      providers: [
        { provide: InvoiceService, useValue: {} },
        { provide: PricingService, useValue: {} },
        { provide: InvoiceDocumentService, useValue: documents },
        // Nur fuer die Konstruktor-Aufloesung: diese Suite beruehrt weder
        // Integritaetspruefung noch Verlauf.
        { provide: IntegrityService, useValue: {} },
        { provide: InvoiceHistoryService, useValue: {} },
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          if (!allow) return false;
          context.switchToHttp().getRequest().user = USER;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    calls.length = 0;
    allow = true;
    failWith = null;
  });

  it('GET invoices/:id/document liefert das ZUGFeRD-PDF als Anhang', async () => {
    const response = await fetch(`${base}/invoices/abc/document`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="Rechnung-2026-001.pdf"',
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      '%PDF-1.7 test',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      format: 'pdf',
      id: 'abc',
      actor: { userId: 'user-1', name: 'sam' },
    });
    // Herkunft für das Abrufprotokoll wird mitgegeben.
    expect(calls[0]?.source).toBeDefined();
  });

  it('GET invoices/:id/xml liefert das Factur-X-CII-XML', async () => {
    const response = await fetch(`${base}/invoices/abc/xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="Rechnung-2026-001-factur-x.xml"',
    );
    expect(await response.text()).toBe('<xml format="xml"/>');
    expect(calls[0]?.format).toBe('xml');
  });

  it('GET invoices/:id/xrechnung liefert die XRechnung als reines XML', async () => {
    const response = await fetch(`${base}/invoices/abc/xrechnung`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="Rechnung-2026-001-xrechnung.xml"',
    );
    expect(await response.text()).toBe('<xml format="xrechnung"/>');
    expect(calls[0]).toMatchObject({ format: 'xrechnung', id: 'abc' });
  });

  it('fordert je Abruf genau einen Dienstaufruf an (jeder Abruf wird protokolliert)', async () => {
    await fetch(`${base}/invoices/abc/document`);
    await fetch(`${base}/invoices/abc/document`);
    await fetch(`${base}/invoices/abc/xrechnung`);
    expect(calls.map((c) => c.format)).toEqual(['pdf', 'pdf', 'xrechnung']);
  });

  it('gibt einen fachlichen Fehler als Statuscode weiter, ohne Anhang', async () => {
    failWith = new InvoiceNotFoundError();
    for (const route of ['document', 'xml', 'xrechnung']) {
      const response = await fetch(`${base}/invoices/gibt-es-nicht/${route}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-disposition')).toBeNull();
    }
  });

  it('ruft den Dienst ohne Anmeldung nicht auf', async () => {
    allow = false;
    for (const route of ['document', 'xml', 'xrechnung']) {
      const response = await fetch(`${base}/invoices/abc/${route}`);
      expect(response.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('kennt die drei Pfade ausschließlich als GET', () => {
    const prototype = InvoiceController.prototype as unknown as Record<string, object>;
    const routes = Object.getOwnPropertyNames(prototype)
      .map((name) => ({
        path: Reflect.getMetadata(PATH_METADATA, prototype[name]) as string | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, prototype[name]) as number | undefined,
      }))
      .filter((r) => r.path?.startsWith('invoices/:id/') && /document|xml|xrechnung/.test(r.path));
    expect(routes.map((r) => r.path).sort()).toEqual([
      'invoices/:id/document',
      'invoices/:id/xml',
      'invoices/:id/xrechnung',
    ]);
    expect(routes.every((r) => r.method === RequestMethod.GET)).toBe(true);
  });
});
