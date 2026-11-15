import { HttpStatus } from '@nestjs/common';
import { ConsentPublicController } from './consent-public.controller';
import { WITHOUT_CSRF } from '../common/decorators/without-csrf.decorator';

/**
 * Regressionstests zu A.13: Die Bestätigung entstand aus einem GET. Mailscanner
 * (Microsoft Safe Links, Proofpoint, Mimecast) rufen Links in eingehender Post
 * ungefragt ab — die Bestätigung belegte dann den Scanner statt den Menschen,
 * dem die Adresse gehört, und taugte als Nachweis nach Paragraf 7 UWG und
 * Artikel 7 DSGVO nicht mehr.
 */
function buildResponse() {
  const sent: { status?: number; type?: string; body?: string } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    type(value: string) {
      sent.type = value;
      return this;
    },
    send(body: string) {
      sent.body = body;
      return this;
    },
  };
  return { res, sent };
}

const TOKEN = 'a'.repeat(43);

describe('[A.13] Bestätigung der Einwilligung', () => {
  it('der GET schreibt NICHTS — er zeigt nur einen Knopf', () => {
    const service = { confirm: jest.fn(), unsubscribe: jest.fn() };
    const controller = new ConsentPublicController(service as never);
    const { res, sent } = buildResponse();

    controller.confirmationPage(TOKEN, res as never);

    expect(service.confirm).not.toHaveBeenCalled();
    expect(sent.status).toBe(HttpStatus.OK);
    expect(sent.body).toContain('<form method="post"');
    expect(sent.body).toContain('Ja, Neuigkeiten bekommen');
  });

  it('das Formular zeigt auf die POST-Route mit demselben Token', () => {
    const service = { confirm: jest.fn(), unsubscribe: jest.fn() };
    const controller = new ConsentPublicController(service as never);
    const { res, sent } = buildResponse();

    controller.confirmationPage(TOKEN, res as never);

    expect(sent.body).toContain(
      `action="/api/consent/confirmation/${TOKEN}"`,
    );
  });

  it('erst der POST bestätigt wirklich', async () => {
    const service = {
      confirm: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn(),
    };
    const controller = new ConsentPublicController(service as never);
    const { res, sent } = buildResponse();

    await controller.confirmation(
      TOKEN,
      { headers: {}, ip: '203.0.113.9' } as never,
      res as never,
    );

    expect(service.confirm).toHaveBeenCalledTimes(1);
    expect(sent.status).toBe(HttpStatus.OK);
    expect(sent.body).toContain('bestätigt');
  });

  it('weist einen unmöglichen Token schon auf der Seite ab', () => {
    const service = { confirm: jest.fn(), unsubscribe: jest.fn() };
    const controller = new ConsentPublicController(service as never);
    const { res, sent } = buildResponse();

    controller.confirmationPage('x'.repeat(200), res as never);

    expect(sent.status).toBe(HttpStatus.NOT_FOUND);
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it('die POST-Route trägt eine begründete CSRF-Ausnahme', () => {
    const reason = Reflect.getMetadata(
      WITHOUT_CSRF,
      ConsentPublicController.prototype.confirmation,
    ) as string | undefined;
    expect(typeof reason).toBe('string');
    expect((reason ?? '').length).toBeGreaterThan(40);
  });
});
