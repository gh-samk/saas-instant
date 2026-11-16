import 'reflect-metadata';
import { readdirSync } from 'fs';
import { join } from 'path';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { WITHOUT_CSRF } from '../decorators/without-csrf.decorator';
import { SessionGuard } from './session.guard';
import { SecondFactorGuard } from './second-factor.guard';
import { RoleGuard } from './role.guard';
import { REQUIRED_ROLE } from '../decorators/require-role.decorator';

/**
 * DIE PFLICHT WIRD AUFGEZÄHLT, NICHT ERINNERT.
 *
 * In Etappe 1 wurde die Nachweispflicht dreimal an einzelnen Routen
 * nachgezogen, und jedes Mal blieb eine übrig ([K4]). Die Lehre steht in
 * `zugang-routen.spec.ts` und gilt hier eine Ebene höher: Dieser Test SUCHT
 * SICH die Controller selbst aus dem Verzeichnisbaum und verlangt für jeden
 * eine Entscheidung. Wer einen neuen Controller anlegt und nichts tut, bekommt
 * einen roten Test — nicht eine offene Route.
 *
 * DREI Aussagen, und jede verlangt je Controller eine Entscheidung:
 * 1. Er hängt am `SitzungGuard` oder steht mit Begründung in der Ausnahmeliste.
 * 2. Er hängt am `ZweitfaktorGuard` oder steht mit Begründung in der zweiten.
 * 3. Jede CSRF-Ausnahme steht mit Begründung in der dritten.
 *
 * Punkt 2 kam mit [W6] dazu. Vorher stand die Entscheidung „die
 * Etappe-2-Controller kommen ohne zweiten Faktor aus" nur in einem
 * Kommentar — ein künftiger `RechnungController` hätte sie stillschweigend
 * geerbt, und niemandem wäre aufgefallen, dass sie für Rechnungsdaten nie
 * geprüft wurde.
 */

/**
 * Controller ohne `SitzungGuard`. Die Liste darf nur wachsen, wenn jemand die
 * Begründung geprüft hat.
 */
const WITHOUT_SESSION: Record<string, string> = {
  AppController:
    'Nur /api/health — ein zustandsloses Lebenszeichen für den Container.',
  RobotsController: '/robots.txt muss für Suchmaschinen anonym lesbar sein.',
  AuthController:
    'Hier findet die Anmeldung selbst statt; eine Sitzung gibt es davor nicht.',
  PublicController:
    'Der öffentliche Anfrageweg. An die Stelle der Sitzung tritt der ' +
    'Schlüssel im Header (AnfrageSchluesselGuard), ein eigenes Rate-Limit und ' +
    'der Honeypot.',
  ConsentSubscriptionController:
    'Das Anmeldeformular des Newsletters. Wer sich einträgt, hat kein Konto ' +
    'und soll keines bekommen. An die Stelle der Sitzung tritt derselbe ' +
    'Schlüssel im Header wie beim Anfrageweg (AnfrageSchluesselGuard), ein ' +
    'eigenes Rate-Limit und der Honeypot.',
  IntakePublicController:
    'Das Aufnahmeformular der Pilotphase. Wer es ausfüllt, hat kein Konto in ' +
    'der Verwaltung und soll keines bekommen — er füllt einmal ein Formular ' +
    'aus und ist fertig. An die Stelle der Sitzung tritt der Zugangstoken in ' +
    'der Adresse: 256 Bit aus randomBytes, gehasht gespeichert, an genau eine ' +
    'Organisation gebunden, formatvorgeprüft und mit einem eigenen ' +
    'Rate-Limit begrenzt. Was er kann, ist eng: die Angaben genau dieser ' +
    'einen Organisation setzen. Lesen kann er nichts — die Seite zeigt ' +
    'ausser dem Organisationsnamen keinen gespeicherten Wert.',
  ConsentPublicController:
    'Bestätigungs- und Abmeldelink aus dem Postfach. Eine Abmeldung, die eine ' +
    'Anmeldung verlangt, ist keine — der Auftrag verlangt ausdrücklich „kein ' +
    'Login, keine Rückfrage, sofort wirksam". An die Stelle der Sitzung tritt ' +
    'ein 256-Bit-Token je Empfänger, der nichts kann ausser die eigene ' +
    'Adresse bestätigen oder abmelden.',
  BackupController:
    'Meldeweg des externen Sicherungswerkzeugs — ein Skript auf dem Server, ' +
    'kein Mensch mit Sitzung. An ihre Stelle tritt der Schlüssel im Header ' +
    '(SicherungSchluesselGuard), zeitkonstant verglichen, ohne den die Route ' +
    'gar nicht existiert (404). Die Route legt nur an und berichtigt; sie ' +
    'kann nichts löschen und nichts zurückspielen.',
  InternalBackupPlanController:
    'Die Instanzliste für den Sicherungs-Agent (GET /api/internal/backup-plan) — ' +
    'ein Dienst im Compose-Netz, kein Mensch mit Sitzung. An die Stelle der ' +
    'Sitzung tritt derselbe Schlüssel im Header wie beim Meldeweg ' +
    '(BackupKeyGuard, zeitkonstant verglichen, ohne gesetzten Schlüssel gibt ' +
    'es die Route nicht: 404). Sie liest nur und liefert Namen, keine Geheimnisse.',
  InternalInvoiceArchiveController:
    'Das entschlüsselte Rechnungsarchiv für den Sicherungs-Agent ' +
    '(GET /api/internal/invoice-archive) — ein Dienst im Compose-Netz, kein ' +
    'Mensch mit Sitzung. An die Stelle der Sitzung tritt derselbe Schlüssel ' +
    'im Header wie beim Sicherungsplan (BackupKeyGuard, zeitkonstant ' +
    'verglichen, ohne gesetzten Schlüssel gibt es die Route nicht: 404). Bei ' +
    'gesperrtem Tresor antwortet die globale Sperre mit 423. Sie liest nur.',
  FlagPublicController:
    'Der Stand der Funktionsschalter für die Kundeninstanzen, anonym und rein ' +
    'lesend: einzelne Wahrheitswerte ohne Personenbezug und ohne Kennung. ' +
    'Die Instanzen haben kein Konto in der Verwaltung und sollen keines ' +
    'bekommen; so muss für einen Schalter nichts auf eine Instanz geschrieben ' +
    'werden (R1). Schreiben lässt sich hier nichts.',
  PublicLogoController:
    'Das Firmenlogo für die Anmeldeseite, anonym und rein lesend (PNG/JPEG ' +
    'mit nosniff und ETag). Das Logo steht ohnehin auf jeder Rechnung; ' +
    'hochgeladen wird es am IssuerSettingsController hinter Sitzung und ' +
    'zweitem Faktor.',
  VaultStatusController:
    'Nur der Tresor-Zustand (uninitialized, locked, unlocked), anonym und rein ' +
    'lesend. Die Anmelde- und Entsperrseite braucht ihn vor der Anmeldung; er ' +
    'verrät nichts über Daten, Konten oder Schlüssel.',
  SsoController:
    'Der Weg in die Verwaltung über das Portal (OIDC Authorization Code + ' +
    'PKCE): start, callback und Front-Channel-Logout. Davor gibt es keine ' +
    'Sitzung. An ihre Stelle treten state, nonce und PKCE-Verifier im ' +
    'signierten Cookie, die einmalige Verbrauchsmarke in der Datenbank und ' +
    'die Signaturprüfung des ID-Tokens. Nur im Modus portal, sonst 404.',
  PublicConfigController:
    'Produktname und Logo für die Anmeldeseite, anonym und rein lesend. ' +
    'Davor gibt es keine Sitzung, und die Seite braucht beides schon ' +
    'vor der Anmeldung. Ausgeliefert wird nur der UI-Teil des Manifests; ' +
    'Mail-, Abrechnungs- und Provisionierungsdaten verlassen den Server ' +
    'nie über diesen Weg.',
};

/**
 * Controller OHNE `ZweitfaktorGuard`. Jede Zeile ist eine abgenommene
 * Abwägung, keine Bequemlichkeit ([W6]).
 */
const WITHOUT_SECOND_FACTOR_CONTROLLER: Record<string, string> = {
  AuditController:
    'Das Sicherheitsprotokoll, rein lesend. Es gibt kein Gegenstück zum ' +
    'Löschen oder Ändern — ein Audit-Log, an dem sich etwas ändern lässt, ist ' +
    'keines. Es hinter den zweiten Faktor zu legen erschwerte ausgerechnet ' +
    'den Blick auf verdächtige Anmeldungen, und den will man im Zweifel ' +
    'sofort.',
  InstancesController:
    'Die Übersicht aller Instanzen, rein lesend: Subdomain, Status, ' +
    'Organisation — keine Geheimnisse, keine Kennzahlen. Jede Zeile führt in ' +
    'den Reiter „Instanz" der Organisation, und alles Schreibende bleibt ' +
    'dort hinter den Schranken, die es dort hat. Ein zweiter Faktor vor einer ' +
    'Liste von Adressen schützte nichts.',
  OutboxController:
    'Löst eine Probe des Postausgangs aus: anmelden am Mailserver, keine ' +
    'Mail, keine Daten, kein Personenbezug. Zurück kommen feste Kategorien. ' +
    'Gebraucht wird sie gerade dann, wenn der Postausgang gestört ist — und ' +
    'dann kommt auch kein Anmeldecode per Mail an.',
  NavigationController:
    'Zwei Zahlen fuer die Seitenleiste, ohne Personenbezug. Sie stammen aus ' +
    'Listen, die hinter derselben Sitzung stehen — ein zweiter Faktor davor ' +
    'schuetzte nichts, was nicht schon geschuetzt ist.',
  PublicLogoController:
    'Kein Benutzer, kein Faktor: anonym, rein lesend, ein Bild ohne ' +
    'Personenbezug.',
  PublicConfigController:
    'Kein Benutzer, kein Faktor: anonym, rein lesend, nur Produktname und ' +
    'Logo aus dem UI-Teil des Manifests, nichts mit Personenbezug.',
  AppController: 'Anonym und zustandslos; es gibt keinen Faktor zu prüfen.',
  VaultStatusController:
    'Kein Benutzer, kein Faktor: anonym, rein lesend, nur der Tresor-Zustand.',
  RobotsController: 'Anonym und zustandslos; es gibt keinen Faktor zu prüfen.',
  AuthController:
    'Hier wird der zweite Faktor überhaupt erst erbracht; ihn vorauszusetzen ' +
    'wäre ein Zirkelschluss.',
  SsoController:
    'Hier wird die Anmeldung überhaupt erst erbracht; der Nachweis ist das ' +
    'ID-Token des Portals samt zweitem Faktor. Der Step-up läuft über dieselbe ' +
    'Strecke und braucht selbst keinen Nachweis davor.',
  PublicController:
    'Kein Benutzer, kein Faktor. An seine Stelle tritt der Schlüssel im ' +
    'Header, das Rate-Limit und der Honeypot.',
  IntakePublicController:
    'Kein Benutzer, kein Faktor — die Absenderin hat kein Konto. An seine ' +
    'Stelle tritt der Einmal-Token in der Adresse, gehasht gespeichert und an ' +
    'genau eine Organisation gebunden, dazu ein enges Rate-Limit auf dem ' +
    'schreibenden Weg. Das ERZEUGEN des Links liegt dagegen sehr wohl hinter ' +
    'dem zweiten Faktor (OrganisationConfidentialController): Er führt zur ' +
    'IBAN-Erfassung.',
  CompanyController:
    'Stammdaten, Status und Notizen. Sie zu ändern ist innerhalb der Sitzung ' +
    'folgenlos für den ZUGANG, vollständig im Audit-Log nachvollziehbar und ' +
    'im Verlauf sichtbar. Alle zehn Minuten das Passwort zu verlangen machte ' +
    'die tägliche Arbeit unmöglich und gewöhnte die Betreiberin daran, es auf ' +
    'Zuruf einzutippen. Zahlungsdaten und Löschung sind ausdrücklich NICHT ' +
    'hier, sondern am OrganisationConfidentialController ([W4]).',
  NoteController:
    'Notizen zu Organisationen; dieselbe Abwägung wie beim ' +
    'OrganisationController. Systemnotizen sind ohnehin unveränderlich.',
  TasksController:
    'Ausschließlich lesend und rein abgeleitet — es gibt nichts zu speichern ' +
    'und nichts zu ändern.',
  ScheduleController:
    'Löst einen Lauf aus, der nur Status ohne Geldfolge wechselt (R5). Jeder ' +
    'Wechsel ist einzeln im Audit-Log und im Verlauf sichtbar.',
  InstanceController:
    'Instanzen anlegen und archivieren. Beides ist KEIN Zugriff auf den ' +
    'Zugang und keine Geldfolge; beides ist vollständig im Audit-Log ' +
    'nachvollziehbar, und dem Anlegen geht eine serverseitig erzwungene ' +
    'Pflicht-Vorschau voraus. Ein zweiter Faktor an dieser Stelle brächte ' +
    'nichts hinzu, was die Vorschau nicht schon leistet, und gewöhnte die ' +
    'Betreiberin daran, ihr Passwort auf Zuruf einzutippen ([W6]). Löschen ' +
    'gibt es hier ohnehin nicht (R1).',
  BackupController:
    'Kein Benutzer, kein Faktor. An seine Stelle tritt der Schlüssel im ' +
    'Header und das Rate-Limit — dieselbe Abwägung wie beim ' +
    'OeffentlichController.',
  InvoiceController:
    'Nur noch ENTWÜRFE und Lesen: anlegen, ändern, löschen, ansehen, Dokument ' +
    'und XML abrufen. Ein Entwurf hat keine Nummer, war nie ein Beleg und ' +
    'lässt sich beliebig zurücknehmen; die Lese-Routen ändern nichts. Alles ' +
    'Unumkehrbare ist mit [K3] an den RechnungAbschlussController gewandert. ' +
    'Für Entwurfsarbeit alle zehn Minuten das Passwort zu verlangen machte ' +
    'die Rechnungsstellung unmöglich und gewöhnte die Betreiberin daran, es ' +
    'auf Zuruf einzutippen ([W6]).',
  ConsentSubscriptionController:
    'Kein Benutzer, kein Faktor. An seine Stelle tritt der Schlüssel im ' +
    'Header, das Rate-Limit und der Honeypot — dieselbe Abwägung wie beim ' +
    'OeffentlichController.',
  ConsentPublicController:
    'Kein Benutzer, kein Faktor. Der Aufrufer ist eine Empfängerin mit einem ' +
    'Link aus ihrem Postfach oder ihr Mailclient (RFC 8058). Einen zweiten ' +
    'Faktor zu verlangen hiesse, die Abmeldung unmöglich zu machen.',
  BroadcastController:
    'Der REDAKTIONSBEREICH: Vorlagen schreiben, Vorschau ansehen, ' +
    'Empfängerauswahl abfragen und den Fortschritt eines Versands ablesen. ' +
    'Auf keiner dieser Routen geht eine Mail hinaus — wer Texte redigiert, ' +
    'erreicht damit niemanden, und jede Änderung steht im Audit-Log. Der ' +
    'Fortschritt ist reines Zählen: keine Adresse, keine Kennung, kein ' +
    'Schreibvorgang, und er stösst keinen Lauf an. Ihn zu schützen hiesse, ' +
    'während eines laufenden Versands alle paar Sekunden das Passwort zu ' +
    'verlangen ([W6]). Das VERSCHICKEN liegt ausdrücklich NICHT hier, ' +
    'sondern am RundmailVersandController.',
  InternalBackupPlanController:
    'Kein Benutzer, kein Faktor. An seine Stelle tritt der Schlüssel im ' +
    'Header und das Rate-Limit — dieselbe Abwägung wie beim BackupController; ' +
    'die Route ist rein lesend.',
  InternalInvoiceArchiveController:
    'Kein Benutzer, kein Faktor. Der Aufrufer ist der Sicherungs-Agent mit ' +
    'dem Schlüssel im Header; die Route liest nur und ist bei gesperrtem ' +
    'Tresor nicht erreichbar (423).',
  FlagPublicController:
    'Kein Benutzer, kein Faktor — der Aufrufer ist eine Instanz. Die Antwort ' +
    'sind Wahrheitswerte ohne Personenbezug; die Route schreibt nichts.',
  FeatureFlagController:
    'Betriebsschalter für alle Instanzen (z. B. Feedback). Jederzeit ' +
    'zurückstellbar, ohne Geldfolge, ohne Zugriff auf einen Zugang und mit ' +
    'vorher/nachher vollständig im Audit-Log — dieselbe Abwägung wie beim ' +
    'OrganisationController. Ein Passwort vor einem Kippschalter gewöhnte ' +
    'die Betreiberin nur daran, es auf Zuruf einzutippen ([W6]).',
};

/**
 * Erlaubte CSRF-Ausnahmen, als `Controller.methode`. Es gibt genau eine, und
 * sie betrifft einen Aufrufer ohne Browser.
 */
const CSRF_EXCEPTIONS = [
  'PublicController.inquiry',
  'BackupController.report',
  'ConsentSubscriptionController.subscription',
  'ConsentPublicController.unsubscribeOneClick',
  // [A.13] Die Bestaetigung ist von GET auf POST gewandert, damit sie nicht
  // mehr von einem Mailscanner ausgeloest werden kann. Der Aufrufer ist ein
  // Mensch aus seinem Postfach, ohne Konto und ohne Sitzung — dieselbe
  // Abwaegung wie bei der Ein-Klick-Abmeldung darueber.
  'ConsentPublicController.confirmation',
  // [A.35] Das Aufnahmeformular. Der Aufrufer ist ein Mensch aus seinem
  // Postfach, ohne Konto und ohne Sitzung — es gibt nichts, wogegen ein
  // Double-Submit pruefen koennte. Anders als bei der Abmeldung ist das
  // Restrisiko nicht null; was stattdessen schuetzt, steht in der Begruendung
  // an der Route.
  'IntakePublicController.step',
  // Dieselbe Route, nur getrennt wegen des engeren Ratenlimits fuer das
  // Schreiben. Die Begruendung an ihr verweist ausdruecklich auf die der
  // Schrittroute — zwei Ausnahmen, EIN Argument.
  'IntakePublicController.submit',
];

interface FoundController {
  name: string;
  class: Function;
  guards: unknown[];
}

/** Sucht alle `*.controller.ts` unter src und lädt die Controller-Klassen. */
function allController(): FoundController[] {
  const root = join(__dirname, '..', '..');
  const found: FoundController[] = [];

  const scan = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        scan(path);
      } else if (
        entry.name.endsWith('.controller.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require(path) as Record<string, unknown>;
        for (const [name, value] of Object.entries(module)) {
          if (typeof value !== 'function') continue;
          if (!Reflect.hasMetadata(PATH_METADATA, value)) continue;
          found.push({
            name,
            class: value,
            guards:
              (Reflect.getMetadata(GUARDS_METADATA, value) as unknown[]) ?? [],
          });
        }
      }
    }
  };

  scan(root);
  return found;
}

/** Alle Routen eines Controllers samt CSRF-Ausnahme. */
function routes(controllerClass: Function): { key: string; exception?: string }[] {
  const prototype = controllerClass.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter(
      (name) =>
        name !== 'constructor' &&
        typeof prototype[name] === 'function' &&
        Reflect.hasMetadata(PATH_METADATA, prototype[name] as object),
    )
    .map((name) => ({
      key: `${controllerClass.name}.${name}`,
      exception: Reflect.getMetadata(WITHOUT_CSRF, prototype[name] as object) as
        | string
        | undefined,
    }));
}

describe('Jeder Controller ist entschieden', () => {
  it('findet überhaupt Controller (sonst prüft der Test nichts)', () => {
    expect(allController().length).toBeGreaterThanOrEqual(10);
  });

  it('hängt jeden Controller an den SitzungGuard oder nennt einen Grund', () => {
    const unprotected = allController()
      .filter((c) => !c.guards.includes(SessionGuard))
      .filter((c) => WITHOUT_SESSION[c.name] === undefined)
      .map((c) => c.name);

    expect(unprotected).toEqual([]);
  });

  it('hat für jede eingetragene Ausnahme auch wirklich einen Controller', () => {
    const existing = new Set(allController().map((c) => c.name));
    for (const name of Object.keys(WITHOUT_SESSION)) {
      expect(existing.has(name)).toBe(true);
    }
  });

  it('verlangt für jede Ausnahme eine tragfähige Begründung', () => {
    for (const reason of Object.values(WITHOUT_SESSION)) {
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it('lässt keine unbegründete CSRF-Ausnahme zu', () => {
    const exceptions = allController()
      .flatMap((c) => routes(c.class))
      .filter((r) => r.exception !== undefined);

    expect(exceptions.map((r) => r.key).sort()).toEqual(
      [...CSRF_EXCEPTIONS].sort(),
    );
    for (const exception of exceptions) {
      // Kein Platzhalter: der Satz muss sagen, WAS stattdessen schützt.
      expect(String(exception.exception).length).toBeGreaterThan(50);
    }
  });

  it('verlangt je Controller auch eine Entscheidung zum zweiten Faktor ([W6])', () => {
    const undecided = allController()
      .filter((c) => !c.guards.includes(SecondFactorGuard))
      .filter((c) => WITHOUT_SECOND_FACTOR_CONTROLLER[c.name] === undefined)
      .map((c) => c.name);

    expect(undecided).toEqual([]);
  });

  it('verlangt für jede Zweitfaktor-Ausnahme eine tragfähige Begründung', () => {
    for (const reason of Object.values(WITHOUT_SECOND_FACTOR_CONTROLLER)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('hat für jede Zweitfaktor-Ausnahme auch wirklich einen Controller', () => {
    const existing = new Set(allController().map((c) => c.name));
    for (const name of Object.keys(WITHOUT_SECOND_FACTOR_CONTROLLER)) {
      expect(existing.has(name)).toBe(true);
    }
  });

  /**
   * DIE ROLLE `staff` (Modus portal) DARF EINSTELLUNGEN, NUTZER, TRESOR UND
   * WIEDERHERSTELLUNG NICHT SCHREIBEN. Die Liste wird aufgezählt, nicht
   * erinnert: eine neue Schreibroute dort fällt hier nicht auf, eine
   * vergessene Markierung an einer bestehenden aber schon.
   */
  it('verlangt die Rolle admin genau an den vorgesehenen Routen', () => {
    const marked: string[] = [];
    for (const c of allController()) {
      const prototype = c.class.prototype as Record<string, unknown>;
      const classLevel = Reflect.getMetadata(REQUIRED_ROLE, c.class) as
        | string
        | undefined;
      for (const route of routes(c.class)) {
        const name = route.key.split('.')[1] as string;
        const method = Reflect.getMetadata(
          REQUIRED_ROLE,
          prototype[name] as object,
        ) as string | undefined;
        if ((method ?? classLevel) === 'admin') marked.push(route.key);
      }
    }
    expect(marked.sort()).toEqual(
      [
        'IssuerSettingsController.update',
        'IssuerSettingsController.uploadLogo',
        'IssuerSettingsController.deleteLogo',
        'PricesController.update',
        'BackupSettingsController.update',
        'BackupSettingsController.test',
        'FeatureFlagController.set',
        'UserController.register',
        'UserController.newLink',
        'UserController.address',
        'UserController.access',
        'VaultController.unlock',
        'VaultController.setup',
        'VaultController.entries',
        'VaultController.legacyPlaintext',
        'VaultController.addPassphrase',
        'VaultController.changePassphrase',
        'VaultController.regenerateRecovery',
        'VaultController.removePassphrase',
        'InstanceBackupsController.startRecovery',
        'InstanceBackupsController.adopt',
      ].sort(),
    );
  });

  it('stellt den RoleGuard zwischen SessionGuard und SecondFactorGuard', () => {
    for (const c of allController()) {
      const hasMarking =
        Reflect.getMetadata(REQUIRED_ROLE, c.class) !== undefined ||
        routes(c.class).some(
          (r) =>
            Reflect.getMetadata(
              REQUIRED_ROLE,
              (c.class.prototype as Record<string, object>)[
                r.key.split('.')[1] as string
              ] as object,
            ) !== undefined,
        );
      if (!hasMarking) continue;
      const session = c.guards.indexOf(SessionGuard);
      const role = c.guards.indexOf(RoleGuard);
      const second = c.guards.indexOf(SecondFactorGuard);
      expect(session).toBeGreaterThanOrEqual(0);
      expect(role).toBeGreaterThan(session);
      // Wer ohnehin abgewiesen wird, tippt vorher keinen Nachweis ein.
      if (second >= 0) expect(second).toBeGreaterThan(role);
    }
  });

  it('hält Zahlungsdaten und Löschung hinter dem zweiten Faktor ([W4])', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    expect(byName['CompanyConfidentialController']).toEqual([
      SessionGuard,
      SecondFactorGuard,
    ]);
    expect(WITHOUT_SECOND_FACTOR_CONTROLLER['CompanyConfidentialController'])
      .toBeUndefined();
  });

  /**
   * ETAPPE 4. Dasselbe Kriterium wie bei [W4], auf Rechnungen angewandt: Der
   * Zahlungsstand ist der einzige Vorgang des Rechnungsmoduls, der KEIN
   * Dokument hinterlässt. Wer mit einem erbeuteten Cookie offene Rechnungen
   * als bezahlt markiert, löscht lautlos Forderungen aus der Übersicht — die
   * Dashboard-Aufgabe „überfällig" verschwindet gleich mit, weil sie
   * abgeleitet ist.
   */
  it('hält den Zahlungsstand hinter dem zweiten Faktor', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    expect(byName['InvoicePaymentController']).toEqual([
      SessionGuard,
      SecondFactorGuard,
    ]);
    expect(WITHOUT_SECOND_FACTOR_CONTROLLER['InvoicePaymentController'])
      .toBeUndefined();
  });

  /**
   * [K3] — DAS KRITERIUM WURDE BERICHTIGT.
   *
   * Es lautet NICHT „hinterlässt ein Dokument", sondern **„lässt sich
   * zurücknehmen"**. Gemessen wurde, dass ein eine Stunde alter Sitzungs-Cookie
   * genügte, um Rechnungsnummern zu verbrennen und Forderungen endgültig
   * aufzuheben, während der korrigierbare Zahlungsvermerk geschützt war. Der
   * zweite Faktor sass auf der falschen Handlung.
   *
   * Dieser Test nagelt die Zuordnung namentlich fest, damit sie beim nächsten
   * Umbau nicht wieder wandert.
   */
  it('hält die UNUMKEHRBAREN Rechnungsvorgänge hinter dem zweiten Faktor', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    expect(byName['InvoiceCompletionController']).toEqual([
      SessionGuard,
      SecondFactorGuard,
    ]);
    expect(WITHOUT_SECOND_FACTOR_CONTROLLER['InvoiceCompletionController'])
      .toBeUndefined();
  });

  /**
   * Und die Gegenprobe: Am ungeschützten `RechnungController` darf KEINE
   * dieser vier Routen mehr hängen. Ohne diese Aussage liesse sich eine von
   * ihnen zurückschieben, und der Test oben bliebe grün.
   */
  it('lässt am RechnungController keine unumkehrbare Route zurück', () => {
    const controller = allController().find(
      (c) => c.name === 'InvoiceController',
    );
    expect(controller).toBeDefined();
    const paths = routes(controller!.class).map((r) => r.key);
    for (const irreversible of [
      'finalize',
      'cancel',
      'send',
      'reminder',
    ]) {
      expect(paths).not.toContain(`InvoiceController.${irreversible}`);
    }
  });

  /**
   * [W4] — DIE SPERRE IST NICHT ZURÜCKNEHMBAR.
   *
   * Dasselbe Kriterium wie bei [K3]: Wer eine Adresse irrtümlich sperrt, kann
   * es nicht rückgängig machen; die Person bekommt bis zu einer neuen eigenen
   * Eintragung nichts mehr, und aus `spam_gemeldet` gibt es gar keinen Weg
   * zurück.
   */
  it('hält das Sperren einer Adresse hinter dem zweiten Faktor', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    expect(byName['ConsentBlockController']).toEqual([
      SessionGuard,
      SecondFactorGuard,
    ]);
    expect(WITHOUT_SECOND_FACTOR_CONTROLLER['ConsentBlockController'])
      .toBeUndefined();
  });

  /**
   * UND ES GIBT KEIN GEGENSTÜCK — aber dieser Test allein beweist das NICHT.
   *
   * ===================================================================
   * WAS ER KANN UND WAS ER NICHT KANN ([K4])
   * ===================================================================
   *
   * Er prüft die ROUTENOBERFLÄCHE: dass niemand einen Endpunkt namens
   * „entsperren" anlegt. Das ist nützlich und billig.
   *
   * ER HAT ABER FALSCHE SICHERHEIT GEGEBEN. Der eigentliche Weg zurück lief
   * nicht über eine zweite Route, sondern über die SPERRROUTE SELBST: Sie
   * schrieb den gemeldeten Zustand bedingungslos, und damit liess sich
   * `spam_gemeldet` auf `abgemeldet` herunterstufen. Ein Test über Namen kann
   * das grundsätzlich nicht sehen.
   *
   * DIE TRAGENDE AUSSAGE STEHT DESHALB WOANDERS: `sperrrang.spec.ts` prüft die
   * Regel, `einwilligung.integration.spec.ts` die vollständige
   * Übergangsmatrix gegen die Datenbank. Dieser Test hier ist die Zugabe, nicht
   * der Beleg.
   */
  it('kennt nirgends eine Route, die eine Sperre aufheben könnte', () => {
    const suspicious = allController()
      .flatMap((c) => routes(c.class))
      .filter((r) =>
        /(entsperr|freigeb|reaktivier|zuruecksetz|opt_?in_?setz)/i.test(
          r.key,
        ),
      );
    expect(suspicious.map((r) => r.key)).toEqual([]);
  });

  /**
   * ETAPPE 5. Dasselbe Kriterium noch einmal, und es fällt hier am
   * deutlichsten aus: Eine verschickte Rundmail lässt sich nicht zurückholen.
   * Es gibt keinen Storno und keine Korrekturbuchung — anders als bei einer
   * Rechnung. Wer mit einem erbeuteten Cookie eine Rundmail einstellt,
   * schreibt im Namen des Hauses an jede Adresse, die je eingewilligt hat.
   */
  it('hält den Rundmail-Versand hinter dem zweiten Faktor', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    expect(byName['BroadcastSendController']).toEqual([
      SessionGuard,
      SecondFactorGuard,
    ]);
    expect(WITHOUT_SECOND_FACTOR_CONTROLLER['BroadcastSendController'])
      .toBeUndefined();
  });

  it('schützt die Etappe-2-Controller ausdrücklich mit dem SitzungGuard', () => {
    const byName = Object.fromEntries(
      allController().map((c) => [c.name, c.guards]),
    );
    for (const name of [
      'CompanyController',
      'CompanyConfidentialController',
      'NoteController',
      'TasksController',
      'ScheduleController',
      // Etappe 3: die Instanzverwaltung hängt an derselben Sitzung.
      'InstanceController',
      // Etappe 4: Rechnungen ebenso.
      'InvoiceController',
      'InvoiceCompletionController',
      'InvoicePaymentController',
      // Etappe 5: Redaktion und Versand der Rundmails.
      'BroadcastController',
      'BroadcastSendController',
    ]) {
      expect(byName[name]).toContain(SessionGuard);
    }
  });
});

/**
 * R1 AN DER ROUTENOBERFLÄCHE.
 *
 * Die Schnittstelle `CoolifyClient` schliesst Löschen bereits aus
 * (`coolify/kein-loeschpfad.spec.ts`). Hier kommt die zweite Ebene dazu: Es
 * darf auch KEINE ROUTE geben, die so etwas anböte — weder ein `@Delete` noch
 * eine Route, deren Pfad nach Löschen oder Wiederherstellen klingt.
 */
/**
 * R2 AN DER ROUTENOBERFLÄCHE.
 *
 * „Nach dem Festschreiben existiert kein Löschbefehl und kein Änderungsbefehl
 * für eine Rechnung — nicht im UI, nicht in der API, nicht in einem Service."
 *
 * Die Ebene des Dienstes prüft `rechnung-unveraenderlich.spec.ts`. Hier geht es
 * um die Routenliste: Es darf keinen Endpunkt geben, der auch nur den Anschein
 * erweckt, eine Rechnung ändern oder löschen zu können — außer den beiden, die
 * ausdrücklich `entwurf` im Pfad tragen.
 */
describe('R2 — an einer Rechnung führt kein Weg vorbei am Entwurf', () => {
  function invoiceRoutes(): { key: string; method: number; path: string }[] {
    return allController()
      .filter((c) => c.name.startsWith('Invoice'))
      .flatMap((c) => {
        const prototype = c.class.prototype as Record<string, unknown>;
        return Object.getOwnPropertyNames(prototype)
          .filter((name) => name !== 'constructor')
          .filter((name) => typeof prototype[name] === 'function')
          .filter((name) =>
            Reflect.hasMetadata(PATH_METADATA, prototype[name] as object),
          )
          .map((name) => ({
            key: `${c.name}.${name}`,
            method: Reflect.getMetadata(
              METHOD_METADATA,
              prototype[name] as object,
            ) as number,
            path: String(
              Reflect.getMetadata(PATH_METADATA, prototype[name] as object),
            ),
          }));
      });
  }

  it('findet überhaupt Rechnungsrouten (sonst prüft der Test nichts)', () => {
    expect(invoiceRoutes().length).toBeGreaterThanOrEqual(10);
  });

  it('hat genau EINE DELETE-Route, und die endet auf /entwurf', () => {
    // RequestMethod.DELETE === 3
    const deleted = invoiceRoutes().filter((r) => r.method === 3);
    expect(deleted.map((r) => r.path)).toEqual(['invoices/:id/draft']);
  });

  it('hat genau EINE PATCH-Route, und die endet auf /entwurf', () => {
    // RequestMethod.PATCH === 4
    const updated = invoiceRoutes().filter((r) => r.method === 4);
    expect(updated.map((r) => r.path)).toEqual(['invoices/:id/draft']);
  });

  it('kennt keine Route, deren Pfad nach Ändern einer Rechnung klingt', () => {
    const suspicious = invoiceRoutes().filter((r) =>
      /(bearbeit|korrigier|nummer|umbuch|zuruecksetz)/i.test(r.path),
    );
    expect(suspicious.map((r) => r.key)).toEqual([]);
  });
});

describe('R1 — keine Route zum Löschen oder Wiederherstellen', () => {
  it('hat nirgends eine DELETE-Route auf Instanzen oder Sicherungen', () => {
    const suspicious = allController()
      .filter((c) => ['InstanceController', 'BackupController'].includes(c.name))
      .flatMap((c) => {
        const prototype = c.class.prototype as Record<string, unknown>;
        return Object.getOwnPropertyNames(prototype)
          .filter((name) => name !== 'constructor')
          .filter((name) => typeof prototype[name] === 'function')
          .filter((name) => Reflect.hasMetadata(PATH_METADATA, prototype[name] as object))
          .map((name) => ({
            key: `${c.name}.${name}`,
            method: Reflect.getMetadata(
              METHOD_METADATA,
              prototype[name] as object,
            ) as number,
            path: String(
              Reflect.getMetadata(PATH_METADATA, prototype[name] as object),
            ),
          }));
      });

    expect(suspicious.length).toBeGreaterThan(0);
    // RequestMethod.DELETE === 3
    expect(suspicious.filter((r) => r.method === 3)).toEqual([]);
    expect(
      suspicious.filter((r) =>
        /(loesch|delete|entfern|wiederherstell|restore)/i.test(r.path),
      ),
    ).toEqual([]);
  });
});
