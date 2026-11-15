import type { Request } from 'express';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  SENDER_HEADER,
  inquiryClientIp,
  inquiryHopsFrom,
  isInquiryPath,
  fromForwarding,
  trackerFor,
} from './inquiry-tracker';
import { sourceFromInquiry, USER_AGENT_MAX } from './inquiry-source';

/** Der Schluessel, den das nginx der Webseite serverseitig anhaengt. */
const KEY = 'der-echte-schluessel-aus-der-umgebung';

/**
 * Baut eine Anfrage mit Pfad, Peer-Adresse und Weiterleitungskette.
 *
 * MIT gueltigem Schluessel, denn das ist der Normalfall der oeffentlichen Wege.
 * Ohne Schluessel: `anfrageOhneSchluessel`.
 */
function inquiry(path: string, ip: string, chain?: string): Request {
  return {
    originalUrl: path,
    ip,
    headers: {
      'x-inquiry-key': KEY,
      ...(chain === undefined ? {} : { 'x-forwarded-for': chain }),
    },
  } as unknown as Request;
}

/** Dieselbe Anfrage, aber ohne den Schluessel des Webseiten-nginx. */
function inquiryWithoutKey(
  path: string,
  ip: string,
  chain?: string,
): Request {
  return {
    originalUrl: path,
    ip,
    headers: chain === undefined ? {} : { 'x-forwarded-for': chain },
  } as unknown as Request;
}

/** Kurzform: `trackerFuer` mit dem echten Schluessel als Erwartung. */
function counterFor(req: Request, hops: number | null): string {
  return trackerFor(req, hops, KEY);
}

/**
 * [W1]: Ein prozessweites `trust proxy` für zwei Wege mit verschieden langen
 * Ketten machte das Limit des Anfragewegs zu einem globalen Kontingent.
 */
describe('trackerFor', () => {
  /**
   * Die Kette, wie sie bei der Anwendung ankommt. Jede Station haengt die
   * Adresse an, VON DER sie empfangen hat — die eigene Adresse des letzten
   * Proxys steht deshalb NICHT darin, sie ist `req.ip`. Vier vertraute
   * Stationen (Traefik, webseite-nginx, Traefik, control-web) bedeuten also
   * vier Eintraege plus die Peer-Adresse.
   */
  const CHAIN = '203.0.113.9, 198.51.100.1, 198.51.100.2, 10.0.0.5';

  it('zählt die Verwaltungsoberfläche weiter gegen req.ip', () => {
    expect(
      counterFor(inquiry('/api/companies', '198.51.100.7', CHAIN), 4),
    ).toBe('198.51.100.7');
  });

  it('zählt den Anfrageweg gegen den Client, nicht gegen den Proxy', () => {
    // Vier vertraute Stationen: vier Einträge übersprungen, übrig bleibt der
    // Client. Dieselbe Rechnung, die Express für `req.ip` anstellt.
    expect(
      counterFor(inquiry('/api/public/inquiry', '10.0.0.6', CHAIN), 4),
    ).toBe('203.0.113.9');
  });

  it('gibt zwei verschiedenen Clients zwei verschiedene Kontingente', () => {
    const a = counterFor(
      inquiry('/api/public/inquiry', '10.0.0.6', CHAIN),
      4,
    );
    const b = counterFor(
      inquiry(
        '/api/public/inquiry',
        '10.0.0.6',
        '203.0.113.77, 198.51.100.1, 198.51.100.2, 10.0.0.5',
      ),
      4,
    );
    expect(a).not.toBe(b);
  });

  it('bleibt ohne eingerichtete Kettenlänge beim bisherigen Verhalten', () => {
    expect(
      counterFor(inquiry('/api/public/inquiry', '10.0.0.6', CHAIN), null),
    ).toBe('10.0.0.6');
  });

  it('fällt bei einer ZU KURZEN Kette auf req.ip zurück', () => {
    // NICHT auf den linkesten Eintrag: der ist frei erfunden, und mit jedem
    // neuen Fantasiewert gäbe es ein frisches Kontingent.
    expect(
      counterFor(
        inquiry('/api/public/inquiry', '10.0.0.6', '203.0.113.9'),
        4,
      ),
    ).toBe('10.0.0.6');
  });

  it('fällt ohne Weiterleitungskopf auf req.ip zurück', () => {
    expect(
      counterFor(inquiry('/api/public/inquiry', '10.0.0.6'), 4),
    ).toBe('10.0.0.6');
  });
});

describe('fromForwarding', () => {
  it('zählt von rechts, weil links die Behauptung des Clients steht', () => {
    const req = inquiry('/x', '1.1.1.1', 'a, b, c, d');
    expect(fromForwarding(req, 1)).toBe('d');
    expect(fromForwarding(req, 2)).toBe('c');
    expect(fromForwarding(req, 4)).toBe('a');
    expect(fromForwarding(req, 5)).toBeNull();
  });

  it('verträgt einen mehrfach gesetzten Kopf', () => {
    const req = {
      originalUrl: '/x',
      ip: '1.1.1.1',
      headers: { 'x-forwarded-for': ['a, b', 'c'] },
    } as unknown as Request;
    expect(fromForwarding(req, 1)).toBe('c');
  });
});

describe('inquiryHopsFrom', () => {
  it('ist ohne Angabe nicht eingerichtet', () => {
    expect(inquiryHopsFrom(undefined)).toBeNull();
    expect(inquiryHopsFrom('   ')).toBeNull();
  });

  it('nimmt ganze Zahlen ab eins', () => {
    expect(inquiryHopsFrom('4')).toBe(4);
  });

  it('bricht bei einem unsinnigen Wert ab, statt still zu raten', () => {
    expect(() => inquiryHopsFrom('0')).toThrow(/CONTROL_INQUIRY_TRUST_PROXY/);
    expect(() => inquiryHopsFrom('zwei')).toThrow();
    expect(() => inquiryHopsFrom('-1')).toThrow();
  });
});

/**
 * ===========================================================================
 * [K2] — DIE LISTE DARF KEINEN ÖFFENTLICHEN WEG VERGESSEN
 * ===========================================================================
 *
 * Etappe 5 brachte einen zweiten unauthentifizierten Schreibweg
 * (`/api/consent/subscription`). Er stand nicht in der Pfadliste und fiel
 * deshalb auf `req.ip` zurück — bei `CONTROL_TRUST_PROXY=2` die Adresse eines
 * Proxys. Alle Besucher der Webseite teilten sich damit weltweit ein
 * Kontingent von fünf Eintragungen je Minute.
 *
 * DER FEHLER IST UNSICHTBAR: Das Rate-Limit greift ja — nur gegen den falschen
 * Zähler. Deshalb wird die Liste hier nicht geprüft, sondern ABGEZÄHLT: Jeder
 * Controller, der am `AnfrageSchluesselGuard` hängt, muss mit seinem Pfad
 * darin stehen. Wer einen dritten öffentlichen Weg baut und die Liste
 * vergisst, bekommt einen roten Test statt eines geteilten Kontingents.
 */
describe('[K2] Jeder öffentliche Schreibweg zählt gegen den richtigen Zähler', () => {
  const CHAIN_K2 = '203.0.113.9, 198.51.100.1, 198.51.100.2, 10.0.0.5';

  it('zählt die Newsletter-Eintragung gegen den Client, nicht gegen den Proxy', () => {
    expect(
      counterFor(
        inquiry('/api/consent/subscription', '10.0.0.9', CHAIN_K2),
        4,
      ),
    ).toBe('203.0.113.9');
  });

  // ENTFERNT MIT [W7]: Hier stand einmal „zählt auch Bestätigung und Abmeldung
  // gegen den Client". Das war genau die falsche Aussage — beide kommen NICHT
  // über das Webseiten-nginx, und das Zählen von rechts wurde dort zur Lücke.
  // Der Ersatz steht weiter unten und prüft das Gegenteil.

  /**
   * ===================================================================
   * [W7] DIE LISTE WIRD IN BEIDE RICHTUNGEN ABGEZÄHLT
   * ===================================================================
   *
   * Die erste Fassung prüfte nur eine Richtung: „jeder Schlüssel-Controller
   * hat einen Eintrag". Damit war ein zu BREITER Eintrag unsichtbar — und
   * genau das ist passiert: `/api/consent` als Präfix deckte auch
   * Bestätigung, Abmeldung und Sperre ab, deren echte Proxy-Kette kürzer ist.
   * Zwei erfundene `X-Forwarded-For`-Einträge genügten dort für ein frisches
   * Kontingent bei jeder Anfrage.
   *
   * Geprüft wird deshalb auf ROUTENEBENE und in beide Richtungen.
   */
  /** Alle Routen aller Controller, mit vollständigem Pfad und Schutzangabe. */
  function allRoutes(): {
    controller: string;
    path: string;
    withKey: boolean;
  }[] {
    const root = join(__dirname, '..');
    const found: {
      controller: string;
      path: string;
      withKey: boolean;
    }[] = [];

    const scan = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          scan(full);
          continue;
        }
        if (!entry.name.endsWith('.controller.ts')) continue;
        if (entry.name.endsWith('.spec.ts')) continue;
        const content = readFileSync(full, 'utf8');
        const withKey = content.includes('InquiryKeyGuard');
        // Der Klassenpfad aus `@Controller('…')`, leer bei `@Controller()`.
        const classPath = /@Controller\((?:'([^']*)')?\)/.exec(content);
        const prefix = classPath?.[1] ?? '';
        // Und die Routenpfade aus den Methoden-Dekoratoren.
        for (const match of content.matchAll(
          /@(?:Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/g,
        )) {
          const part = match[1] ?? '';
          const path = ['/api', prefix, part]
            .filter((piece) => piece !== '')
            .join('/')
            .replace(/\/+/g, '/');
          found.push({ controller: entry.name, path, withKey });
        }
      }
    };
    scan(root);
    return found;
  }

  it('findet überhaupt Routen (sonst prüft der Test nichts)', () => {
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(routes.filter((r) => r.withKey).length).toBeGreaterThanOrEqual(2);
  });

  it('deckt JEDE Route ab, die sich mit dem Schlüssel ausweist', () => {
    const uncovered = allRoutes()
      .filter((r) => r.withKey)
      .filter((r) => !isInquiryPath(r.path))
      .map((r) => r.path);
    expect(uncovered).toEqual([]);
  });

  /**
   * DIE RICHTUNG, DIE GEFEHLT HAT. Eine Route ohne Schlüssel kommt nicht über
   * das Webseiten-nginx; ihre Kette ist kürzer, und dann liest
   * `ausWeiterleitung` in die vom Client selbst geschriebenen Einträge hinein.
   */
  it('deckt KEINE Route ab, die sich nicht mit dem Schlüssel ausweist', () => {
    const tooMuchCovered = allRoutes()
      .filter((r) => !r.withKey)
      .filter((r) => isInquiryPath(r.path))
      .map((r) => `${r.controller}:${r.path}`);
    expect(tooMuchCovered).toEqual([]);
  });

  it.each([
    '/api/consent/confirmation/abc',
    '/api/consent/unsubscribe/abc',
    '/api/consent/blocklist',
  ])('zählt %s wieder gegen req.ip', (path) => {
    // Diese drei kommen aus dem Postfach, vom Mailclient oder aus einer
    // Sitzung — nicht über das nginx der Webseite.
    expect(isInquiryPath(path)).toBe(false);
    expect(counterFor(inquiry(path, '198.51.100.7', CHAIN_K2), 4)).toBe(
      '198.51.100.7',
    );
  });

  it('lässt sich mit erfundenen Einträgen kein frisches Kontingent erschleichen', () => {
    // Der gemessene Angriff: zwei Fantasiewerte vorangestellt. Auf einer
    // Route, die nicht über das nginx kommt, zählt jetzt wieder `req.ip` —
    // und die ist die Peer-Adresse, nicht fälschbar.
    const invented = `1.2.3.4, 5.6.7.8, ${CHAIN_K2}`;
    const key = new Set(
      ['abc', 'def', 'ghi'].map((token) =>
        counterFor(
          inquiry(`/api/consent/unsubscribe/${token}`, '198.51.100.7', invented),
          4,
        ),
      ),
    );
    expect([...key]).toEqual(['198.51.100.7']);
  });
});

/**
 * Der Befund A.8: Der `ThrottlerGuard` ist ein `APP_GUARD` und laeuft VOR dem
 * `AnfrageSchluesselGuard` des Controllers. Die Begruendung „wer die Route
 * erreicht, hat den Schluessel bewiesen" stimmt an dieser Stelle also noch
 * nicht. Ohne eigene Pruefung genuegte ein erfundener `X-Forwarded-For` je
 * Anfrage fuer ein frisches Kontingent — und jede danach abgewiesene Anfrage
 * schreibt eine Zeile ins Audit-Log, das keinen Loeschlauf hat.
 */
describe('[A.8] Ohne gueltigen Schluessel zaehlt die Peer-Adresse', () => {
  const CHAIN = '203.0.113.9, 198.51.100.1, 198.51.100.2, 10.0.0.5';

  it('zaehlt den Anfrageweg ohne Schluessel gegen req.ip', () => {
    expect(
      trackerFor(
        inquiryWithoutKey('/api/public/inquiry', '10.0.0.9', CHAIN),
        4,
        KEY,
      ),
    ).toBe('10.0.0.9');
  });

  it('zaehlt bei falschem Schluessel gegen req.ip', () => {
    const req = {
      originalUrl: '/api/public/inquiry',
      ip: '10.0.0.9',
      headers: { 'x-inquiry-key': 'wrong', 'x-forwarded-for': CHAIN },
    } as unknown as Request;
    expect(trackerFor(req, 4, KEY)).toBe('10.0.0.9');
  });

  it('erschleicht sich ohne Schluessel KEIN frisches Kontingent', () => {
    // Der Angriff: je Anfrage zwei erfundene Eintraege voranstellen.
    const key = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((invented) =>
        trackerFor(
          inquiryWithoutKey(
            '/api/public/inquiry',
            '10.0.0.9',
            `${invented}, ${CHAIN}`,
          ),
          4,
          KEY,
        ),
      ),
    );
    // Alle drei zaehlen gegen denselben Schluessel — das Limit greift.
    expect(key.size).toBe(1);
  });

  it('mit gueltigem Schluessel gilt weiterhin die Weiterleitungskette', () => {
    expect(
      trackerFor(inquiry('/api/public/inquiry', '10.0.0.9', CHAIN), 4, KEY),
    ).toBe('203.0.113.9');
  });

  it('faellt auf req.ip zurueck, wenn gar kein Schluessel eingerichtet ist', () => {
    expect(
      trackerFor(inquiry('/api/public/inquiry', '10.0.0.9', CHAIN), 4, undefined),
    ).toBe('10.0.0.9');
    expect(
      trackerFor(inquiry('/api/public/inquiry', '10.0.0.9', CHAIN), 4, '  '),
    ).toBe('10.0.0.9');
  });
});

/**
 * SEIT 15.09.2026: Die echte Absender-IP im NACHWEIS (Anfrage, AGB-Zustimmung,
 * Newsletter-Eintragung) – dieselbe Rechnung wie beim Rate-Limit.
 *
 * Die Kette am Ende: Client, Traefik, webseite-nginx, Traefik – vier Einträge;
 * control-web ist die Peer-Adresse (`req.ip`).
 */
describe('Herkunft auf den öffentlichen Wegen', () => {
  const PATH = '/api/public/inquiry';
  const PROXY = '10.0.1.1';
  const REAL_CHAIN = '203.0.113.7, 10.0.2.5, 2.28.57.3, 10.0.1.9';

  it('nennt den Formularbesucher statt des Proxys', () => {
    const req = inquiry(PATH, PROXY, REAL_CHAIN);
    expect(sourceFromInquiry(req, 4, KEY).ip).toBe('203.0.113.7');
    expect(inquiryClientIp(req, 4, KEY)).toBe('203.0.113.7');
  });

  it('lässt sich mit vorangestellten Fantasiewerten NICHT täuschen', () => {
    // Links schreibt der Absender, was er will – gezählt wird von rechts.
    const req = inquiry(PATH, PROXY, `1.2.3.4, 5.6.7.8, ${REAL_CHAIN}`);
    expect(sourceFromInquiry(req, 4, KEY).ip).toBe('203.0.113.7');
  });

  it('bleibt ohne gültigen Schlüssel bei req.ip – der Header zählt dann nicht', () => {
    expect(
      sourceFromInquiry(inquiryWithoutKey(PATH, PROXY, REAL_CHAIN), 4, KEY).ip,
    ).toBe(PROXY);
    expect(sourceFromInquiry(inquiry(PATH, PROXY, REAL_CHAIN), 4, 'ein-anderer').ip).toBe(
      PROXY,
    );
  });

  it('bleibt ohne eingerichtete Kettenlänge bei req.ip', () => {
    expect(sourceFromInquiry(inquiry(PATH, PROXY, REAL_CHAIN), null, KEY).ip).toBe(
      PROXY,
    );
  });

  it('weicht bei zu kurzer Kette NICHT auf den linkesten Eintrag aus', () => {
    // Der linkeste wäre frei erfunden.
    expect(sourceFromInquiry(inquiry(PATH, PROXY, '1.2.3.4, 10.0.1.9'), 4, KEY).ip).toBe(
      PROXY,
    );
  });

  it('behält den gekürzten User-Agent wie herkunftAus', () => {
    const req = inquiry(PATH, PROXY, REAL_CHAIN);
    (req.headers as Record<string, string>)['user-agent'] = 'x'.repeat(USER_AGENT_MAX + 50);
    const { userAgent } = sourceFromInquiry(req, 4, KEY);
    expect(userAgent?.length).toBe(USER_AGENT_MAX + 1);
  });

  it('zählt das Rate-Limit gegen dieselbe Adresse, die der Nachweis nennt', () => {
    const req = inquiry(PATH, PROXY, REAL_CHAIN);
    expect(counterFor(req, 4)).toBe(sourceFromInquiry(req, 4, KEY).ip);
  });
});

/**
 * GEMESSEN AM 15.09.2026: Der zweite Traefik verwirft das X-Forwarded-For des
 * Webseiten-nginx; bei der Verwaltung kamen nur zwei interne Einträge an. Die
 * Adresse kommt deshalb in einer eigenen Kopfzeile, die Traefik durchreicht.
 */
describe('Eigene Kopfzeile des Webseiten-nginx', () => {
  const PATH = '/api/public/inquiry';
  const PROXY = '10.0.3.5';
  const AS_IN_PRODUCTION = '10.0.1.1, 10.0.3.6';

  function withHeaderLine(value: string, key: string | null = KEY): Request {
    return {
      originalUrl: PATH,
      ip: PROXY,
      headers: {
        ...(key === null ? {} : { 'x-inquiry-key': key }),
        'x-forwarded-for': AS_IN_PRODUCTION,
        [SENDER_HEADER]: value,
      },
    } as unknown as Request;
  }

  it('nennt mit Schlüssel die Adresse aus der Kopfzeile – auch bei zu kurzer Kette', () => {
    expect(sourceFromInquiry(withHeaderLine('176.3.8.92'), 4, KEY).ip).toBe('176.3.8.92');
    expect(sourceFromInquiry(withHeaderLine('2001:db8::7'), 4, KEY).ip).toBe('2001:db8::7');
  });

  it('glaubt der Kopfzeile OHNE Schlüssel nicht', () => {
    expect(sourceFromInquiry(withHeaderLine('203.0.113.9', null), 4, KEY).ip).toBe(PROXY);
    expect(sourceFromInquiry(withHeaderLine('203.0.113.9', 'wrong'), 4, KEY).ip).toBe(PROXY);
  });

  it('verwendet keinen Wert, der keine IP ist', () => {
    for (const nonsense of ['', 'unbekannt', '1.2.3', '<script>', '1.2.3.4, 5.6.7.8']) {
      expect(inquiryClientIp(withHeaderLine(nonsense), 4, KEY)).toBeNull();
    }
  });

  it('gilt auch ohne eingerichtete Kettenlänge', () => {
    expect(sourceFromInquiry(withHeaderLine('176.3.8.92'), null, KEY).ip).toBe('176.3.8.92');
  });

  it('zählt auch das Rate-Limit gegen den Besucher statt gegen den Proxy', () => {
    expect(counterFor(withHeaderLine('176.3.8.92'), 4)).toBe('176.3.8.92');
    expect(counterFor(withHeaderLine('198.51.100.4'), 4)).toBe('198.51.100.4');
  });
});

