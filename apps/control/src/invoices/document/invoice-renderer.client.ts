import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InvoiceRendererNotConfiguredError,
  InvoiceRendererNotReachableError,
  InvoiceDocumentInvalidError,
} from '../invoice.errors';

/**
 * DER AUFRUF DES RECHNUNGSDIENSTES.
 *
 * Der Dienst selbst ist der belegte Erkundungsschritt aus
 * `tools/invoice-renderer/`: Chromium setzt das HTML, Mustangproject macht
 * daraus als Java-Bibliothek PDF/A-3 mit eingebettetem `factur-x.xml` und
 * PRÜFT DAS ERGEBNIS SELBST nach (veraPDF plus Schematron EN 16931). Er läuft
 * in einem eigenen Container neben der API und ist ausschließlich aus dem
 * Compose-Netz erreichbar — er hat weder Anmeldung noch Rechteprüfung.
 *
 * DIESE KLASSE BAUT NICHTS NACH. Sie schickt HTML und XML hin und nimmt das
 * fertige PDF entgegen. Die eine Entscheidung, die hier fällt, ist die
 * wichtigste: WAS BEI 422 GESCHIEHT. Der Dienst antwortet mit 422 und dem
 * Prüfbericht, wenn das erzeugte Dokument seine eigene Prüfung nicht besteht.
 * Diese Antwort wird NICHT als „na gut, dann eben so" behandelt — sie wird zu
 * einem Fehler, und es wird nichts gespeichert. Ein ungültiger Beleg ist
 * schlechter als kein Beleg: Er sieht aus wie einer.
 */

/** Was der Dienst kann. Abschließend, wie `CoolifyClient`. */
export interface InvoiceRenderer {
  /** Ist der Dienst konfiguriert? */
  isConfigured(): boolean;
  /** HTML rein, PDF/A-3b mit eingebettetem `factur-x.xml` raus. */
  create(html: string, xml: string): Promise<Buffer>;
}

export const INVOICE_RENDERER = Symbol('Rechnungsdienst');

/** Vorgabe im Compose-Netz. */
export const INVOICE_RENDERER_DEFAULT = 'http://rechnungsdienst:8080';

/**
 * Zeitgrenze eines Aufrufs.
 *
 * Der Erkundungsschritt hat gemessen: Der ERSTE Aufruf kostet rund 1,4
 * Sekunden, weil Mustang die Schematron-Regeln als XSLT übersetzt und
 * zwischenspeichert; danach rund eine Drittelsekunde. Sechzig Sekunden sind
 * großzügig — sie decken einen kalten Container ab und schneiden trotzdem ab,
 * bevor ein hängender Aufruf die Anfrage endlos offen hält.
 */
export const TIMEOUT_MS = 60_000;

@Injectable()
export class InvoiceRendererHttpClient implements InvoiceRenderer {
  private readonly logger = new Logger(InvoiceRendererHttpClient.name);

  constructor(private readonly config: ConfigService) {}

  private base(): string | null {
    const value = this.config.get<string>('RECHNUNGSDIENST_URL')?.trim();
    if (value) return value.replace(/\/+$/, '');
    // Im Compose-Netz ist der Dienst unter seinem Servicenamen erreichbar.
    // Ohne gesetzte Variable gilt diese Vorgabe — sie ist richtig, sobald der
    // Compose-Block eingehängt ist, und erzeugt sonst einen sichtbaren
    // Verbindungsfehler statt stiller Wirkungslosigkeit.
    return INVOICE_RENDERER_DEFAULT;
  }

  isConfigured(): boolean {
    return this.base() !== null;
  }

  async create(html: string, xml: string): Promise<Buffer> {
    const base = this.base();
    if (base === null) throw new InvoiceRendererNotConfiguredError();

    const body = JSON.stringify({
      html: Buffer.from(html, 'utf8').toString('base64'),
      xml: Buffer.from(xml, 'utf8').toString('base64'),
      // EN 16931, nicht XRECHNUNG: Empfängerinnen sind private Vereine und
      // Genossenschaften. XRechnung verlangte zusätzlich Leitweg-ID und
      // Geschäftsprozesskennung, die es hier nicht gibt.
      profil: 'EN16931',
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/erzeuge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: abort.signal,
      });
    } catch (exception) {
      // FESTER SCHLÜSSEL statt durchgereichter Meldung: Die rohe Meldung von
      // `fetch` enthält die Ziel-URL, und die ist eine interne Adresse.
      const reason =
        exception instanceof Error && exception.name === 'AbortError'
          ? 'timeout'
          : 'unreachable';
      this.logger.error(
        `Rechnungsdienst nicht erreichbar (${reason}): ` +
          (exception instanceof Error ? exception.message : String(exception)),
      );
      throw new InvoiceRendererNotReachableError(reason);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 422) {
      // DIE ENTSCHEIDENDE STELLE. Der Dienst hat sein eigenes Ergebnis
      // geprüft und verworfen. Der Bericht geht mit, weil er der einzige Weg
      // zur Ursache ist; er beschreibt ausschließlich das erzeugte Dokument.
      const report = await response.text().catch(() => '(kein Bericht lesbar)');
      this.logger.error(
        'Der Rechnungsdienst hat das erzeugte Dokument als ungültig ' +
          'zurückgewiesen. Es wird nichts gespeichert.',
      );
      throw new InvoiceDocumentInvalidError(report);
    }

    if (!response.ok) {
      this.logger.error(
        `Rechnungsdienst antwortete mit HTTP ${response.status}.`,
      );
      throw new InvoiceRendererNotReachableError(`http_${response.status}`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    // Ein PDF beginnt mit `%PDF-`. Die Prüfung ist billig und fängt den Fall
    // ab, dass ein Proxy eine Fehlerseite mit Status 200 zurückgibt.
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new InvoiceRendererNotReachableError('no_pdf_response');
    }
    return data;
  }
}

/**
 * Der Ersatz, wenn `RECHNUNGSDIENST_URL` ausdrücklich leer gesetzt ist.
 *
 * Dieselbe Bauweise wie `CoolifyNotConfiguredClient`: Eine fehlende
 * Konfiguration führt zu einem fachlichen Fehler an genau der Stelle, an der
 * sie fehlt — nicht zu einer stillen Wirkungslosigkeit. Rechnungen lassen sich
 * damit weiterhin anlegen, festschreiben und stornieren; nur das PDF fehlt,
 * und das sagt die Antwort auch.
 */
@Injectable()
export class InvoiceRendererNotConfiguredClient implements InvoiceRenderer {
  isConfigured(): boolean {
    return false;
  }

  create(): Promise<Buffer> {
    return Promise.reject(new InvoiceRendererNotConfiguredError());
  }
}
