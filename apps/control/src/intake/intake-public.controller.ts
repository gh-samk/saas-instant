import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { WithoutCsrf } from '../common/decorators/without-csrf.decorator';
import { sourceFrom } from '../common/inquiry-source';
import { IssuerConfigService } from '../invoices/document/issuer.config';
import { isHttpUrl } from '../common/http-url';
import { IntakeService, WEBSITE_MESSAGE } from './intake.service';
import { IntakeAccessService } from './intake-access.service';
import {
  thanksPage,
  checkPage,
  stepPage,
  invalidPage,
  type Inputs,
} from './form-pages';
import {
  allFields,
  nextStep,
  checkPaymentPairingInForm,
  CheckStep,
  Steps,
  previousStep,
} from './steps';

/**
 * Höchstlänge eines Tokens in der Adresse — wie bei der Einwilligung.
 * 32 Zufallsbytes werden als base64url zu 43 Zeichen.
 */
const TOKEN_MAX = 64;

/** Höchstlänge eines einzelnen Formularwerts. */
const VALUE_MAX = 500;

function isPossibleToken(value: string): boolean {
  return value.length > 0 && value.length <= TOKEN_MAX && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * ===========================================================================
 * DAS AUFNAHMEFORMULAR — ÖFFENTLICH, MIT TOKEN, OHNE KONTO
 * ===========================================================================
 *
 * KEIN `SessionGuard` und kein Schlüssel im Header. Wer das Formular ausfüllt,
 * hat kein Konto in der Verwaltung und soll keines bekommen — er füllt einmal
 * ein Formular aus und ist fertig. An die Stelle der Sitzung tritt der Token:
 * 256 Bit, an genau eine Organisation gebunden, gehasht gespeichert.
 *
 * WAS ER KANN, IST ENG: die Angaben genau dieser einen Organisation setzen.
 * Er liest nichts — die Seite zeigt ausser dem Organisationsnamen keinen
 * gespeicherten Wert. Wer einen fremden Token abfängt, erfährt daraus nichts,
 * was er nicht schon weiss.
 *
 * KEIN ZWISCHENSPEICHER. Der Zustand reist in versteckten Feldern durch die
 * Schritte; der Server merkt sich nichts. Wer die Seite schliesst, hinterlässt
 * nichts — und der Link bleibt gültig, weil kein Zwischenschritt ihn anfasst.
 *
 * `Cache-Control: no-store` auf JEDER Antwort, nicht nur auf denen mit IBAN:
 * Eine Ausnahmeregel, die man je Route entscheiden muss, wird eines Tages
 * falsch entschieden.
 */
@Controller('intake')
export class IntakePublicController {
  constructor(
    private readonly accesses: IntakeAccessService,
    private readonly intake: IntakeService,
    // Fuer Glaeubigername und -kennung im Mandatswortlaut. Die Seiten sind
    // reine Funktionen und lesen keine Konfiguration; sie bekommen die zwei
    // Werte hereingereicht.
    private readonly issuer: IssuerConfigService,
  ) {}

  /**
   * Glaeubigerangaben fuer den Mandatskasten.
   *
   * BEWUSST EINE METHODE UND KEIN GETTER. Als Getter lief sie los, sobald
   * irgendetwas die Eigenschaften dieser Klasse durchging — und
   * `controller-schutz.spec.ts` tut genau das, ohne Abhaengigkeiten zu
   * stellen. Eine Eigenschaft, deren blosses Lesen einen Dienst aufruft, ist
   * eine Falle fuer jeden, der die Klasse von aussen betrachtet.
   */
  private async creditor(): Promise<{ name: string; id: string }> {
    const a = (await this.issuer.current()).issuer;
    return { name: a.name, id: a.creditorId };
  }

  /** Der Einstieg aus der Mail: Schritt 1, leer. */
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async start(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isPossibleToken(token)) return this.invalid(res);
    const checked = await this.accesses.check(token);
    if (!checked) return this.invalid(res);

    this.send(
      res,
      HttpStatus.OK,
      stepPage({
        token,
        companyName: checked.companyName,
        step: 1,
        inputs: {},
      }),
    );
  }

  /**
   * Jeder Schrittwechsel — vorwärts, rückwärts, „Ändern" und das Absenden.
   *
   * EIN EINZIGER ENDPUNKT, weil es ein einziges Formular ist. Welcher Schritt
   * als Nächstes kommt, sagt der gedrückte Knopf (`_ziel`); wo man herkommt,
   * steht in `_schritt`. Beides sind Formularwerte und deshalb nicht
   * vertrauenswürdig — sie werden geprüft, nicht geglaubt.
   *
   * `@OhneCsrf`: Es gibt keine Sitzung, gegen die ein Double-Submit prüfen
   * könnte, und der Absender hat kein Konto. Das Restrisiko — ein fremdes
   * Formular postet auf einen erratenen Token — steht gegen 256 Bit Zufall,
   * die Formatvorprüfung und ein enges Rate-Limit. Anders als bei der
   * Abmeldung ist es nicht null, deshalb steht es hier ausdrücklich.
   */
  @Post(':token')
  @WithoutCsrf(
    'Das Aufnahmeformular hat keine Sitzung, gegen die ein Double-Submit ' +
      'pruefen koennte, und die Absenderin hat kein Konto. An die Stelle des ' +
      'CSRF-Tokens tritt der Zugangstoken in der Adresse: 256 Bit aus ' +
      'randomBytes, gehasht gespeichert, an genau eine Organisation gebunden, ' +
      'formatvorgeprueft und mit 5 Anfragen je Minute begrenzt. Das ' +
      'Restrisiko ist nicht null — ein fremdes Formular koennte auf einen ' +
      'erratenen Token posten —, aber ein erratener 256-Bit-Token ist kein ' +
      'CSRF-Angriff mehr, sondern ein geloester Zufall.',
  )
  /**
   * ===================================================================
   * 20 JE MINUTE, NICHT 5
   * ===================================================================
   *
   * Hier standen 5 — gedacht als Schutz fuer das ABSENDEN. Nur teilt sich
   * das Absenden diese Route mit jedem Schrittwechsel, und ein Weg durch
   * das Formular braucht sechs POST: fuenf Mal „Weiter" und einmal
   * „Absenden". Der SECHSTE lief ins Limit. Wer das Formular korrekt und
   * zuegig ausfuellte, bekam am Ende
   * `{"fehler":{"code":"HTTP_429"}}` statt der Dankseite — und der Zugang
   * blieb unverbraucht, waehrend die eingegebenen Daten weg waren. Gemeldet
   * am 07.09.2026 an der ausgerollten Fassung.
   *
   * Wer zurueckblaettert und Angaben aendert, braucht noch mehr. 20 traegt
   * einen vollstaendigen Durchgang samt Korrekturen; das Absenden ist
   * inzwischen eine eigene Route mit eigenem, engem Limit.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async step(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!isPossibleToken(token)) return this.invalid(res);
    const checked = await this.accesses.check(token);
    if (!checked) return this.invalid(res);

    const inputs = this.inputsFrom(body);
    const from = this.stepFrom(body['_step']);
    const target = String(body['_target'] ?? 'next');
    const paymentMethod = inputs['paymentMethod'];

    // „Ändern" aus der Prüfansicht: direkt zum genannten Schritt, ohne
    // Prüfung — es wird ja nichts abgeschickt, nur zurückgeblättert.
    const change = /^step-([1-5])$/.exec(target);
    if (change) {
      return this.showStep(res, token, checked.companyName, Number(change[1]), inputs);
    }

    if (target === 'back') {
      return this.showStep(
        res,
        token,
        checked.companyName,
        previousStep(from, paymentMethod),
        inputs,
      );
    }

    // „Absenden" gehoert auf die eigene Route `/absenden` (engeres Limit).
    // Der Knopf dort traegt `formaction`; kommt es trotzdem hier an — ein
    // Browser ohne `formaction`, ein nachgebautes Formular —, wird es hier
    // beantwortet statt abgewiesen. Ein Weg, der funktioniert hat, soll
    // nicht daran scheitern, dass es einen zweiten gibt.
    if (target === 'submit') {
      return this.submitForm(res, token, checked.companyName, inputs, req);
    }

    // WEITER: erst prüfen, was dieser Schritt verlangt.
    const error = this.checkStep(from, inputs);
    if (error.length > 0) {
      return this.send(
        res,
        HttpStatus.OK,
        stepPage({
          token,
          companyName: checked.companyName,
          step: from,
          inputs,
          error,
          creditor: await this.creditor(),
        }),
      );
    }

    const after = nextStep(from, paymentMethod);
    return this.showStep(res, token, checked.companyName, after, inputs);
  }

  /**
   * ===================================================================
   * DAS ABSENDEN — eigene Route, eigenes Limit
   * ===================================================================
   *
   * Sie tut dasselbe wie `_ziel=absenden` auf der Schrittroute, hat aber
   * ein enges Limit (5/min). Das war die urspruengliche Absicht: Das
   * Absenden schreibt, die Schrittwechsel nicht. Beides an einem Limit
   * bedeutete, dass ein normaler Durchgang das Kontingent des Schreibens
   * aufbrauchte — der sechste POST wurde abgewiesen.
   *
   * Der Knopf der Pruefansicht traegt `formaction` auf diese Route; das
   * Formular selbst zeigt weiter auf die Schrittroute, damit die
   * „Aendern"-Knoepfe dort landen. Beides ohne JavaScript.
   */
  @Post(':token/submit')
  @WithoutCsrf(
    'Dieselbe Begruendung wie an der Schrittroute: keine Sitzung, kein ' +
      'Konto, an ihrer Stelle der 256-Bit-Zugangstoken in der Adresse. ' +
      'Getrennt ist sie nur, weil das Schreiben ein engeres Ratenlimit ' +
      'braucht als das Blaettern.',
  )
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async submit(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!isPossibleToken(token)) return this.invalid(res);
    const checked = await this.accesses.check(token);
    if (!checked) return this.invalid(res);

    return this.submitForm(
      res,
      token,
      checked.companyName,
      this.inputsFrom(body),
      req,
    );
  }

  /**
   * Das Absenden.
   *
   * Der Dienst prüft ALLES noch einmal — die Schrittprüfungen waren
   * Bequemlichkeit, keine Zusicherung. Fehlt etwas, kommt die Prüfansicht mit
   * einer Fehlerliste zurück, und der Token ist NICHT verbraucht.
   *
   * Ein zweites Absenden bekommt 200 und die Dankseite, nicht 404: Wer den
   * Zurück-Knopf drückt oder zweimal klickt, soll nicht rätseln, ob seine
   * Angaben verloren sind.
   */
  private async submitForm(
    res: Response,
    token: string,
    companyName: string,
    inputs: Inputs,
    req: Request,
  ): Promise<void> {
    const result = await this.intake.save(
      token,
      inputs,
      sourceFrom(req),
    );

    if (result.kind === 'incomplete') {
      return this.send(
        res,
        HttpStatus.OK,
        checkPage({
          token,
          companyName,
          step: CheckStep,
          inputs,
          error: result.error.map((f) => ({
            field: f.field,
            message: `${f.label} fehlt noch.`,
          })),
        }),
      );
    }

    if (result.kind === 'invalid') {
      return this.send(
        res,
        HttpStatus.OK,
        checkPage({
          token,
          companyName,
          step: CheckStep,
          inputs,
          error: result.error,
        }),
      );
    }

    this.send(res, HttpStatus.OK, thanksPage(companyName));
  }

  // --- Hilfsmittel --------------------------------------------------------

  private async showStep(
    res: Response,
    token: string,
    companyName: string,
    step: number,
    inputs: Inputs,
  ): Promise<void> {
    const creditor = await this.creditor();
    const page =
      step >= CheckStep
        ? checkPage({
            token,
            companyName,
            step: CheckStep,
            inputs,
            creditor,
          })
        : stepPage({
            token,
            companyName,
            step,
            inputs,
            creditor,
          });
    this.send(res, HttpStatus.OK, page);
  }

  /**
   * Die Formularwerte, gesäubert.
   *
   * NUR BEKANNTE FELDNAMEN. Ein fremder Name wird verworfen, statt als
   * verstecktes Feld weiterzureisen — sonst liesse sich über das Formular
   * beliebiger Inhalt durch die Schritte schleusen und in der Prüfansicht
   * anzeigen.
   */
  private inputsFrom(body: Record<string, unknown>): Inputs {
    const allowed = new Set(allFields('direct_debit').map((f) => f.name));
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(body)) {
      if (!allowed.has(name)) continue;
      if (typeof value !== 'string') continue;
      result[name] = value.slice(0, VALUE_MAX).trim();
    }
    return result;
  }

  private stepFrom(value: unknown): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > CheckStep) return 1;
    return number;
  }

  /** Was dieser Schritt an Pflichtfeldern verlangt. */
  private checkStep(
    number: number,
    inputs: Inputs,
  ): { field: string; message: string }[] {
    const step = Steps.find((s) => s.number === number);
    if (!step) return [];
    const missing = step.fields
      .filter((field) => field.required && (inputs[field.name] ?? '') === '')
      .map((field) => ({
        field: field.name,
        message:
          field.kind === 'checkbox'
            ? 'Ohne diese Zustimmung können wir den Beitrag nicht einziehen.'
            : `Bitte ${field.label} angeben.`,
      }));
    if (missing.length > 0) return missing;

    const website = inputs['website'] ?? '';
    if (step.fields.some((f) => f.name === 'website') && website !== '' && !isHttpUrl(website)) {
      return [{ field: 'website', message: WEBSITE_MESSAGE }];
    }

    // ERST WENN BEIDES DASTEHT, laesst sich die Paarung pruefen. Vorher
    // waere „Monatlich geht nur per Lastschrift" eine Antwort auf eine Frage,
    // die noch niemand beantwortet hat.
    const pairing = checkPaymentPairingInForm(
      inputs['paymentInterval'],
      inputs['paymentMethod'],
    );
    return pairing ? [pairing] : [];
  }

  private invalid(res: Response): void {
    this.send(res, HttpStatus.NOT_FOUND, invalidPage());
  }

  private send(res: Response, status: HttpStatus, html: string): void {
    res
      .status(status)
      .type('html')
      // NIEMALS in einen Zwischenspeicher: Die Seiten tragen Bankdaten in
      // versteckten Feldern, und sie hängen an einem Einmal-Link.
      .setHeader('Cache-Control', 'no-store')
      .send(html);
  }
}
