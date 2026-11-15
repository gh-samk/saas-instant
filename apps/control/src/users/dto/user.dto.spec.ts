import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AccessDto } from './user.dto';

/**
 * PATCH /api/benutzer/:id/zugang — geprüft mit DERSELBEN Pipe wie in `main.ts`.
 *
 * Bis zur Prüfung vom 13.09.2026 trug `aktiv` keinen Decorator. Die Pipe mit
 * `whitelist` + `forbidNonWhitelisted` behandelte das Feld deshalb als fremd
 * und wies jede Anfrage mit 400 ab. Die Service-Tests liefen am Controller
 * vorbei und sahen das nicht; dieser Test sitzt genau an der Stelle, an der
 * es scheiterte.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function asBody(raw: unknown): Promise<AccessDto> {
  return pipe.transform(raw, { type: 'body', metatype: AccessDto }) as Promise<AccessDto>;
}

describe('ZugangDto (Zugang entziehen oder erteilen)', () => {
  it('nimmt aktiv=false an — Zugang entziehen', async () => {
    const dto = await asBody({ active: false });
    expect(dto).toBeInstanceOf(AccessDto);
    expect(dto.active).toBe(false);
  });

  it('nimmt aktiv=true zusammen mit dem Nachweis an', async () => {
    const dto = await asBody({ active: true, currentPassword: 'geheim' });
    expect(dto.active).toBe(true);
    expect(dto.currentPassword).toBe('geheim');
  });

  it('nimmt den Nachweis per TOTP-Code an', async () => {
    const dto = await asBody({ active: false, totpCode: '123456' });
    expect(dto.totpCode).toBe('123456');
  });

  it('weist einen fehlenden Wert ab', async () => {
    await expect(asBody({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('weist eine Zeichenkette statt eines Wahrheitswerts ab', async () => {
    // Keine stille Umdeutung: "false" als Text wäre truthy, und der Controller
    // prüft `dto.aktiv === true`.
    await expect(asBody({ active: 'false' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('weist fremde Felder weiterhin ab', async () => {
    await expect(
      asBody({ active: true, role: 'owner' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
