import type { ConfigService } from '@nestjs/config';
import type { CoolifyConfigService } from '../coolify/coolify.config';
import type { ErrorClass, MailService } from '../mail/mail.service';
import {
  OutboxService,
  nextState,
  type ProbeTransport,
} from './outbox.service';
import type { OutboxRole } from './outbox.types';

/**
 * NUR DIE ÜBERGEBENEN WERTE — kein `ConfigService`. Der liest zuerst
 * `process.env` bzw. die geladene `.env`, und dort steht lokal ein
 * `SMTP_HOST`: Die Tests „ohne Netz" hätten sonst einen Mailserver
 * angesprochen.
 */
function environmentFrom(values: Record<string, string>): ConfigService {
  return {
    get: (name: string, defaultValue?: unknown) => values[name] ?? defaultValue,
  } as unknown as ConfigService;
}

type Transportwahl = ProbeTransport | 'nicht_eingerichtet' | 'nichts_zu_pruefen';

/** Ohne Netz: Die Tests reichen die Transporte selbst herein. */
class CheckableOutbox extends OutboxService {
  transporte: Partial<Record<OutboxRole, Transportwahl>> = {};
  limitMs = 1_000;
  protected override probeTransport(role: OutboxRole): Transportwahl {
    return this.transporte[role] ?? 'nichts_zu_pruefen';
  }
  protected override timeLimitMs(): number {
    return this.limitMs;
  }
}

function succeeds(): ProbeTransport & { verify: jest.Mock; close: jest.Mock } {
  return { verify: jest.fn().mockResolvedValue(true), close: jest.fn() };
}

function fails(code: string, text: string) {
  return {
    verify: jest.fn().mockRejectedValue(Object.assign(new Error(text), { code })),
    close: jest.fn(),
  };
}

function build(environment: Record<string, string> = {}) {
  const send: {
    error: { timestamp: string; errorClass: ErrorClass } | null;
  } = { error: null };
  const mail = {
    sendState: () => ({
      configured: true,
      tlsEnforced: true,
      lastError: send.error,
    }),
  } as unknown as MailService;
  const config = { read: () => null } as unknown as CoolifyConfigService;
  const service = new CheckableOutbox(environmentFrom(environment), mail, config);
  return { service, send };
}

const situationFrom = (service: OutboxService, role: OutboxRole) =>
  service.situation().find((l) => l.role === role)!;

describe('Postausgang — Probe', () => {
  it('meldet eine gelungene Probe als in Ordnung und schließt den Transport', async () => {
    const { service } = build();
    const transport = succeeds();
    service.transporte.admin = transport;

    await service.checkAll();

    expect(situationFrom(service, 'admin').state).toBe('in_ordnung');
    expect(transport.close).toHaveBeenCalledTimes(1);
    // Nichts zu prüfen ist KEIN Fehler.
    expect(situationFrom(service, 'instances').state).toBe('ungeprueft');
  });

  it('erkennt ein falsches Passwort als Anmeldefehler — genau der Fall vom 12.09.2026', async () => {
    const { service } = build();
    service.transporte.admin = fails(
      'EAUTH',
      'Invalid login: 535 5.7.8 Error: authentication failed',
    );

    const situation = await service.checkAll();

    expect(situation.find((l) => l.role === 'admin')).toMatchObject({
      state: 'gestoert',
      errorClass: 'login',
      detectedBy: 'probe',
    });
    expect(situationFrom(service, 'admin').disruptedSince).not.toBeNull();
  });

  it('erklärt die Störung für behoben, sobald eine Probe wieder gelingt', async () => {
    const { service } = build();
    service.transporte.admin = fails('EAUTH', 'Invalid login');
    await service.checkAll();
    service.transporte.admin = succeeds();
    await service.checkAll();

    expect(situationFrom(service, 'admin')).toMatchObject({
      state: 'in_ordnung',
      disruptedSince: null,
      errorClass: null,
    });
  });

  it('wertet eine hängende Probe nach der Zeitgrenze als Verbindungsfehler', async () => {
    const { service } = build();
    service.limitMs = 20;
    const hangs = { verify: () => new Promise(() => undefined), close: jest.fn() };
    service.transporte.admin = hangs;

    await service.checkAll();

    expect(situationFrom(service, 'admin')).toMatchObject({
      state: 'gestoert',
      errorClass: 'verbindung',
    });
    expect(hangs.close).toHaveBeenCalled();
  });

  it('meldet den fehlenden Postausgang der Instanzen als „nicht eingerichtet"', async () => {
    const { service } = build();
    service.transporte.instances = 'nicht_eingerichtet';
    await service.checkAll();
    expect(situationFrom(service, 'instances').state).toBe('nicht_eingerichtet');
  });

  it('löst bei einem Doppelklick nur EINE Anmeldung am Mailserver aus', async () => {
    const { service } = build();
    const transport = succeeds();
    service.transporte.admin = transport;

    await Promise.all([service.checkAll(), service.checkAll()]);

    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it('prüft stündlich nicht, wenn der Schalter aus ist', async () => {
    const { service } = build({ CONTROL_OUTBOX_PROBE_ENABLED: 'nein' });
    const transport = succeeds();
    service.transporte.admin = transport;

    await service.hourly();

    expect(transport.verify).not.toHaveBeenCalled();
  });
});

describe('Postausgang — echter Versand', () => {
  it('zeigt einen Versandfehler, auch wenn noch nie geprüft wurde', () => {
    const { service, send } = build();
    send.error = { timestamp: '2026-09-12T09:30:00.000Z', errorClass: 'login' };

    expect(situationFrom(service, 'admin')).toMatchObject({
      state: 'gestoert',
      errorClass: 'login',
      detectedBy: 'send',
      disruptedSince: '2026-09-12T09:30:00.000Z',
    });
  });

  it('lässt eine spätere gelungene Probe einen Anmeldefehler beim Versand aufheben', async () => {
    const { service, send } = build();
    send.error = {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      errorClass: 'login',
    };
    service.transporte.admin = succeeds();
    await service.checkAll();

    expect(situationFrom(service, 'admin').state).toBe('in_ordnung');
  });

  it('lässt eine Absenderabsage stehen, die eine Probe gar nicht prüfen kann', async () => {
    // verify() schickt keinen Umschlag — ein „MAIL FROM"-Problem sieht es nicht.
    const { service, send } = build();
    send.error = {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      errorClass: 'absender_abgewiesen',
    };
    service.transporte.admin = succeeds();
    await service.checkAll();

    expect(situationFrom(service, 'admin')).toMatchObject({
      state: 'gestoert',
      errorClass: 'absender_abgewiesen',
    });
  });

  it('zählt eine Empfängerabsage NICHT als Störung des Postausgangs', () => {
    const { service, send } = build();
    send.error = {
      timestamp: '2026-09-12T09:30:00.000Z',
      errorClass: 'empfaenger_abgewiesen',
    };
    expect(situationFrom(service, 'admin').state).toBe('ungeprueft');
  });

  it('ordnet den Versand nur der Verwaltung zu', () => {
    const { service, send } = build();
    send.error = { timestamp: '2026-09-12T09:30:00.000Z', errorClass: 'login' };
    expect(situationFrom(service, 'instances').state).toBe('ungeprueft');
  });
});

describe('nextState', () => {
  const empty = { checkedAt: null, disruptedSince: null, errorClass: null, notSetUp: false };

  it('hält den Beginn einer Störung fest, auch wenn sie andauert', () => {
    const first = nextState(
      empty,
      { kind: 'gescheitert', errorClass: 'login' },
      new Date('2026-09-12T08:00:00Z'),
    );
    const then = nextState(
      first,
      { kind: 'gescheitert', errorClass: 'verbindung' },
      new Date('2026-09-12T09:00:00Z'),
    );
    expect(then.disruptedSince).toEqual(new Date('2026-09-12T08:00:00Z'));
    expect(then.checkedAt).toEqual(new Date('2026-09-12T09:00:00Z'));
    expect(then.errorClass).toBe('verbindung');
  });
});

describe('Postausgang — echter Aufbau ohne Netz', () => {
  it('hat nichts zu prüfen, wenn weder SMTP_HOST noch Coolify eingerichtet sind', async () => {
    const mail = {
      sendState: () => ({ configured: false, tlsEnforced: true, lastError: null }),
    } as unknown as MailService;
    const config = { read: () => null } as unknown as CoolifyConfigService;
    const service = new OutboxService(environmentFrom({}), mail, config);

    const situation = await service.checkAll();

    expect(situation.map((l) => l.state)).toEqual(['ungeprueft', 'ungeprueft']);
  });

  it('meldet „nicht eingerichtet", wenn Coolify läuft, der Instanz-Postausgang aber fehlt', async () => {
    const mail = {
      sendState: () => ({ configured: false, tlsEnforced: true, lastError: null }),
    } as unknown as MailService;
    const config = { read: () => ({ instanceSmtp: null }) } as unknown as CoolifyConfigService;
    const service = new OutboxService(environmentFrom({}), mail, config);

    await service.checkAll();

    expect(service.situation().find((l) => l.role === 'instances')!.state).toBe(
      'nicht_eingerichtet',
    );
  });
});
