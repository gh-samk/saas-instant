import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import {
  ChevronDown,
  Copy,
  Fingerprint,
  KeyRound,
  Mail,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Dialog,
  FilterChips,
  Select,
  InputField,
  Card,
  Button,
  EmptyState,
  Skeleton,
  Spinner,
  Table,
  useToast,
} from '@saas-instant/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { PasskeyButton } from '../components/PasskeyButton';
import type { PasskeyState } from '../components/PasskeyButton';
import { PasswordWithStrength } from '../components/PasswordWithStrength';
import { EmailCodeInput } from '../components/EmailCodeInput';
import { TotpInput } from '../components/TotpInput';
import { RecoveryCodeList } from '../components/RecoveryCodeList';
import { UserManagement } from '../components/UserManagement';
import { FeatureFlagManagement } from '../components/FeatureFlagManagement';
import { PricesCard } from '../components/PricesCard';
import { IssuerProfileCard } from '../components/IssuerProfileCard';
import { BackupSettingsCard } from '../components/BackupSettingsCard';
import { SecurityLog } from '../components/SecurityLog';
import { VaultSecurityCard } from '../components/VaultSecurityCard';
import { SecondFactorEvidenceDialog } from '../components/SecondFactorEvidenceDialog';
import { useAuth } from '../context/AuthContext';
import {
  CODE_AGAIN_AFTER_SECONDS,
  signOutAllDevices,
  emailCodeConfirm,
  emailCodeSetup,
  factorRemove,
  fetchDevices,
  passkeyEnrollmentComplete,
  passkeyEnrollmentStart,
  passwordSet,
  totpConfirm,
  totpSetup,
  revokeDevice,
  recoveryCodesNew,
} from '../lib/api';
import type {
  DeviceEntry,
  TotpSetup,
  SecondFactorEvidence,
} from '../lib/api';
import {
  ApiError,
  loginCodeWaitSecondsFrom,
  errorText,
  blockSecondsFrom,
} from '../lib/api-client';
import { asMinutesSeconds, useCountdown } from '../lib/countdown';
import { emailCodeMessageFrom } from '../lib/email-code-error';
import { tableText, tableRow } from '../lib/density';
import {
  newPasswordValid,
  passwordStrength,
} from '../lib/password-strength';
import { TEXT_BUTTON, TEXT_BUTTON_TOUCH } from '../lib/styles';
import { formatDate } from '../utils/date';
import { maskEmail } from '../utils/email-mask';
import { passkeyEnrollment, passkeysPossible } from '../lib/webauthn';
import { useT, t } from '../i18n';

const COLUMNS = [
  t('einstellungen.columnLabel'),
  t('einstellungen.columnCreatedAt'),
  t('einstellungen.columnLastSeenAt'),
  t('einstellungen.columnValidUntil'),
  t('einstellungen.columnActions'),
];

/** Aktionen, für die der Server einen Zweitfaktor-Nachweis verlangt. */
type EvidencePurpose =
  | 'email-code'
  | 'totp-setup'
  | 'codes-new'
  | 'factor-remove'
  | 'passkey-revoke';

const EVIDENCE_EXPLANATION: Record<EvidencePurpose, string> = {
  'email-code':
    t('einstellungen.verifyReasonEmail'),
  'totp-setup':
    t('einstellungen.verifyReasonNewMethod'),
  'codes-new':
    t('einstellungen.verifyReasonNewCodes'),
  'factor-remove':
    t('einstellungen.verifyReasonRemoveMethod'),
  'passkey-revoke':
    t('einstellungen.verifyReasonPasskey'),
};

/** Gruppiert das TOTP-Geheimnis in Viererblöcke (bessere Abtippbarkeit). */
function inGroupsOfFour(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/**
 * Die fünf Reiter der Einstellungen.
 *
 * DIE REIHENFOLGE IST DIE DES ENTWURFS und folgt der Häufigkeit: Zugangsdaten
 * ändert man am ehesten, Geräte sieht man am seltensten an. „Sicherheit"
 * steht dazwischen, weil dort das Protokoll liegt — der Reiter, den man im
 * Verdachtsfall sucht. „Funktionen" (Schalter für alle Instanzen) steht
 * hinten: Er betrifft nicht das eigene Konto, sondern den Betrieb.
 */
const TABS = [
  { value: 'credentials', label: t('einstellungen.tabCredentials') },
  { value: 'security', label: t('einstellungen.tabSecurity') },
  { value: 'user', label: t('einstellungen.tabUsers') },
  { value: 'devices', label: t('einstellungen.tabDevices') },
  { value: 'features', label: t('einstellungen.tabFeatures') },
  { value: 'company', label: t('einstellungen.tabCompany') },
  { value: 'prices', label: t('einstellungen.tabPrices') },
  { value: 'backup', label: t('backup.settingsTitle') },
] as const;

type TabsValue = (typeof TABS)[number]['value'];

export function SettingsPage() {
  const t = useT();
  const toast = useToast();
  const { state, reload } = useAuth();
  const [parameter, setParameter] = useSearchParams();
  // Rolle „Mitarbeit" (nur im Modus portal): Schreibkarten sind gesperrt.
  const staff = state?.accessRole === 'staff';
  // Portal-Sitzung: Passwort, zweiter Faktor, Passkeys und Merk-Geräte liegen
  // beim Portal; die Reiter dafür entfallen.
  const viaPortal = state?.viaPortal === true;
  const visibleTabs = viaPortal
    ? TABS.filter((r) => r.value !== 'credentials' && r.value !== 'devices')
    : TABS;

  /**
   * DER OFFENE REITER STEHT IN DER URL, nicht nur im Zustand.
   *
   * Damit lässt sich auf einen Reiter verweisen — etwa aus einer Mail „sieh
   * dir das Protokoll an" —, und ein Neuladen landet wieder dort. Dieselbe
   * Bauart wie auf der Organisationsseite.
   */
  const tabs: TabsValue =
    visibleTabs.find((r) => r.value === parameter.get('tab'))?.value ??
    visibleTabs[0].value;
  const setTabs = (value: string) => {
    setParameter(
      (previous) => {
        const updated = new URLSearchParams(previous);
        // Der erste Reiter ist die Vorgabe und braucht keinen Parameter.
        if (value === visibleTabs[0].value) updated.delete('tab');
        else updated.set('tab', value);
        return updated;
      },
      { replace: true },
    );
  };

  // Ab `sm` die Chipleiste, darunter eine Auswahlliste (siehe unten).
  const tabsInline = useMediaQuery('(min-width: 640px)');
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revocationFor, setRevocationFor] = useState<DeviceEntry | null>(null);
  const [revocationLoading, setRevocationLoading] = useState(false);
  const [revocationError, setRevocationError] = useState<string | null>(null);

  const [passkeyState, setPasskeyState] = useState<PasskeyState>('idle');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceKind, setEvidenceKind] = useState<'password' | 'totp'>('password');
  const [evidencePassword, setEvidencePassword] = useState('');
  const [evidenceCode, setEvidenceCode] = useState('');
  const [evidenceError, setEvidenceError] = useState<string>();

  const [allLogoutOpen, setAllLogoutOpen] = useState(false);
  const [allLogoutLoading, setAllLogoutLoading] = useState(false);
  const [allLogoutError, setAllLogoutError] = useState<string | null>(
    null,
  );

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errorCurrent, setErrorCurrent] = useState<string>();
  const [errorRepeat, setErrorRepeat] = useState<string>();
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [newCreateOpen, setNewCreateOpen] = useState(false);
  const [codesLoading, setCodesLoading] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [codesConfirmed, setCodesConfirmed] = useState(false);
  const [codesError, setCodesError] = useState<string | null>(null);

  // --- Anmeldemethoden ----------------------------------------------------
  // Ein Dialog für Einrichten UND Adressänderung: beides ist derselbe
  // serverseitige Vorgang (Code an die Zieladresse, danach bestätigen).
  const [emailDialog, setEmailDialog] = useState<
    'add' | 'change' | null
  >(null);
  const [emailStep, setEmailStep] = useState<'start' | 'code'>('start');
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSendLoading, setEmailSendLoading] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState<number | null>(null);
  const [emailCooldownRound, setEmailCooldownRound] = useState(0);
  const emailCooldownRest = useCountdown(emailCooldown, emailCooldownRound);
  /** Der gehaltene Code ist verbrannt oder abgelaufen — es braucht einen neuen. */
  const [newCodeRequired, setNewCodeRequired] = useState(false);
  /**
   * Wofür der Server gerade einen Zweitfaktor-Nachweis verlangt.
   *
   * Drei Aktionen brauchen ihn: eine Code-Adresse einrichten oder ändern, einen
   * Faktor entfernen, einen Passkey widerrufen. Ein Dialog für alle drei — der
   * Nachweis ist derselbe, nur der erklärende Satz unterscheidet sich.
   */
  const [evidencePurpose, setEvidencePurpose] = useState<EvidencePurpose | null>(null);
  const [evidenceDialogError, setEvidenceDialogError] = useState<string>();

  const [totpDialogOpen, setTotpDialogOpen] = useState(false);
  /**
   * `start` erklärt nur; erst die bewusste Handlung fordert ein Geheimnis an.
   *
   * Vorher geschah das beim Öffnen des Dialogs — wer ihn öffnete und abbrach,
   * stand danach ohne funktionierenden Authenticator da.
   */
  const [totpStep, setTotpStep] = useState<'start' | 'code'>('start');
  const [totpSetupData, setTotpSetupData] =
    useState<TotpSetup | null>(null);
  const [totpQrDataUrl, setTotpQrDataUrl] = useState<string | null>(null);
  const [totpManualOpen, setTotpManualOpen] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string>();
  const [totpLoading, setTotpLoading] = useState(false);

  const [removeFor, setRemoveFor] = useState<
    'totp' | 'email-code' | null
  >(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /** Gesetzt, wenn der Widerruf am „letzten Faktor" scheitern würde. */
  const [lastFactorFor, setLastFactorFor] =
    useState<DeviceEntry | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetchDevices();
      setDevices(response.devices);
      setLoadError(null);
    } catch (e) {
      setDevices(null);
      setLoadError(
        errorText(e, t('einstellungen.devicesLoadError')),
      );
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  /**
   * Behandelt ein 401 auf einer Aktion, die einen Nachweis verlangen kann.
   *
   * Ein 401 heißt hier dreierlei: Nachweis nötig, Nachweis falsch oder Sitzung
   * tot. Deshalb erst den Stand nachladen — ist die Sitzung weg, führt die
   * Anwendung regulär zur Anmeldeseite, statt den Dialog in eine Schleife aus
   * „Aktuelles Passwort ist falsch" laufen zu lassen.
   *
   * Gibt `true` zurück, wenn der Aufrufer nichts weiter anzeigen soll.
   */
  async function evidenceRequired(
    e: unknown,
    purpose: EvidencePurpose,
    evidence: SecondFactorEvidence | undefined,
  ): Promise<boolean> {
    if (!(e instanceof ApiError) || e.status !== 401) return false;
    await reload().catch(() => undefined);
    if (evidence) {
      setEvidenceDialogError(
        evidence.totpCode !== undefined
          ? t('einstellungen.codeWrongRetry')
          : t('einstellungen.currentPasswordWrong'),
      );
    } else {
      setEvidencePurpose(purpose);
    }
    return true;
  }

  /**
   * Widerruft einen Eintrag der Geräteliste.
   *
   * Bei einem **Passkey** verlangt der Server denselben Nachweis wie beim
   * Hinzufügen; bei einem **Merk-Gerät** nicht — das nimmt niemandem etwas weg.
   * Wie überall erst ohne Nachweis versuchen: Bei frischer Sitzung fragt der
   * Server gar nicht.
   */
  async function confirmRevocation(
    evidence?: SecondFactorEvidence,
  ): Promise<void> {
    if (!revocationFor) return;
    setRevocationLoading(true);
    setRevocationError(null);
    setEvidenceDialogError(undefined);
    try {
      await revokeDevice(revocationFor.id, evidence);
      toast.show(t('einstellungen.revokedToast', { label: revocationFor.label }));
      setRevocationFor(null);
      setEvidencePurpose(null);
      await loadDevices();
      await reload();
    } catch (e) {
      if (await evidenceRequired(e, 'passkey-revoke', evidence)) return;
      setRevocationError(
        errorText(e, t('einstellungen.revokeFailed')),
      );
    } finally {
      setRevocationLoading(false);
    }
  }

  /**
   * Legt einen Passkey an. Vorher ist der zweite Faktor nachzuweisen: Ein
   * gestohlenes Sitzungs-Cookie soll nicht reichen, um sich einen eigenen,
   * einstufigen Dauerzugang einzurichten.
   */
  async function addPasskey(evidence: SecondFactorEvidence): Promise<void> {
    setPasskeyState('loading');
    setPasskeyError(null);
    setEvidenceError(undefined);
    try {
      const { options } = await passkeyEnrollmentStart(evidence);
      setEvidenceOpen(false);
      setEvidencePassword('');
      setEvidenceCode('');
      const response = await passkeyEnrollment(options);
      await passkeyEnrollmentComplete(response);
      toast.show(t('einstellungen.passkeyAdded'));
      setPasskeyState('idle');
      await loadDevices();
      await reload();
    } catch (e) {
      // Abgelehnter Nachweis: der Dialog bleibt offen und sagt, was fehlt.
      if (e instanceof ApiError && (e.status === 401 || e.status === 400)) {
        setEvidenceError(
          evidence.totpCode !== undefined
            ? t('einstellungen.codeWrongRetry')
            : t('einstellungen.currentPasswordWrong'),
        );
        setPasskeyState('idle');
        return;
      }
      setEvidenceOpen(false);
      setPasskeyError(
        t('einstellungen.passkeyCreateFailed'),
      );
      setPasskeyState('error');
    }
  }

  async function handleSignOutAll(): Promise<void> {
    setAllLogoutLoading(true);
    setAllLogoutError(null);
    try {
      await signOutAllDevices();
      toast.show(t('einstellungen.allDevicesSignedOut'));
      setAllLogoutOpen(false);
      // Zuerst der Stand: der Server beendet dabei auch die eigene Sitzung,
      // dieser Aufruf liefert also ein 401 und die Anwendung führt regulär zur
      // Anmeldeseite zurück. Die Geräteliste danach ist nur für den Fall, dass
      // die Sitzung wider Erwarten weiterlebt.
      await reload();
      await loadDevices();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAllLogoutOpen(false);
        return;
      }
      setAllLogoutError(
        errorText(e, t('einstellungen.signOutAllFailed')),
      );
    } finally {
      setAllLogoutLoading(false);
    }
  }

  async function updatePassword(): Promise<void> {
    setPasswordLoading(true);
    setErrorCurrent(undefined);
    setPasswordError(null);
    try {
      await passwordSet(
        newPassword,
        currentRequired ? currentPassword : undefined,
      );
      toast.show(t('einstellungen.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
      setErrorRepeat(undefined);
      // Die Merk-Geräte sind serverseitig entwertet — Liste und Stand neu holen.
      await loadDevices();
      await reload();
    } catch (e) {
      // Ein falsches aktuelles Passwort zählt serverseitig auf den Sperrzähler
      // ein — die Sperre kann also auch hier zuschlagen.
      const seconds = blockSecondsFrom(e);
      if (seconds !== null) {
        setPasswordError(
          t('einstellungen.blockedRetry', { time: asMinutesSeconds(seconds) }),
        );
        return;
      }
      if (currentRequired && e instanceof ApiError && e.status === 401) {
        setErrorCurrent(t('einstellungen.currentPasswordWrong'));
        return;
      }
      setPasswordError(
        errorText(e, t('einstellungen.passwordChangeFailed')),
      );
    } finally {
      setPasswordLoading(false);
    }
  }

  async function createCodes(evidence?: SecondFactorEvidence): Promise<void> {
    setCodesLoading(true);
    setCodesError(null);
    setEvidenceDialogError(undefined);
    try {
      const response = await recoveryCodesNew(evidence);
      setCodes(response.codes);
      setCodesConfirmed(false);
      setNewCreateOpen(false);
      setEvidencePurpose(null);
      await reload();
    } catch (e) {
      if (await evidenceRequired(e, 'codes-new', evidence)) return;
      setCodesError(
        errorText(e, t('einstellungen.codesCreateFailed')),
      );
    } finally {
      setCodesLoading(false);
    }
  }

  // --- Anmeldemethoden: E-Mail-Code ---------------------------------------

  /** Öffnet den E-Mail-Dialog frisch, ohne Reste des letzten Versuchs. */
  function openEmailDialog(kind: 'add' | 'change'): void {
    setEmailDialog(kind);
    setEmailStep('start');
    setNewEmail('');
    setEmailCode('');
    setEmailError(undefined);
    setEmailCooldown(null);
    setNewCodeRequired(false);
    setEvidenceDialogError(undefined);
  }

  /**
   * Schickt einen Bestätigungscode an die Zieladresse. Ohne `neueEmail` geht er
   * an die bereits hinterlegte Adresse; die neue wird erst mit dem
   * bestätigten Code übernommen.
   */
  async function sendEmailCode(evidence?: SecondFactorEvidence): Promise<void> {
    setEmailSendLoading(true);
    setEmailError(undefined);
    setEvidenceDialogError(undefined);
    try {
      const target = newEmail.trim();
      await emailCodeSetup(target.length > 0 ? target : undefined, evidence);
      setEmailCode('');
      setEmailStep('code');
      setNewCodeRequired(false);
      setEvidencePurpose(null);
      setEmailCooldown(CODE_AGAIN_AFTER_SECONDS);
      setEmailCooldownRound((r) => r + 1);
    } catch (e) {
      const wait = loginCodeWaitSecondsFrom(e);
      if (wait !== null) {
        // Es ist bereits ein Code unterwegs — das Feld darf trotzdem stehen.
        setEmailStep('code');
        setEvidencePurpose(null);
        setEmailCooldown(wait);
        setEmailCooldownRound((r) => r + 1);
        return;
      }
      // Der Server verlangt einen Zweitfaktor-Nachweis: Mit einem erbeuteten
      // Sitzungs-Cookie ließe sich sonst die Zustelladresse des zweiten
      // Faktors auf ein fremdes Postfach umbiegen. Erst ohne versuchen — bei
      // einer frischen Sitzung entfällt die Rückfrage ganz.
      if (await evidenceRequired(e, 'email-code', evidence)) return;
      setEmailError(
        errorText(
          e,
          t('einstellungen.codeSendFailed'),
        ),
      );
    } finally {
      setEmailSendLoading(false);
    }
  }

  async function confirmEmailCode(): Promise<void> {
    setEmailLoading(true);
    setEmailError(undefined);
    try {
      await emailCodeConfirm(emailCode);
      toast.show(
        emailDialog === 'change'
          ? t('einstellungen.emailChanged')
          : t('einstellungen.emailCodeSetUp'),
      );
      setEmailDialog(null);
      await reload();
    } catch (e) {
      // `detail.grund` trennt Tippfehler, verbrannten und abgelaufenen Code.
      const { text, newCodeRequired: deadCode } = emailCodeMessageFrom(e);
      // Ohne Grund (kein Code hinterlegt) hat der Server hier einen
      // brauchbaren Wortlaut — anders als auf dem Anmeldeweg.
      setEmailError(text ?? errorText(e, t('einstellungen.codeWrongRetry')));
      setNewCodeRequired(deadCode);
      if (deadCode) setEmailCode('');
    } finally {
      setEmailLoading(false);
    }
  }

  // --- Anmeldemethoden: Authenticator-App ---------------------------------

  /**
   * Öffnet den TOTP-Dialog — ohne jeden Serverkontakt.
   *
   * Das Anfordern eines Geheimnisses ist eine Änderung am Konto und gehört
   * deshalb hinter eine bewusste Handlung, nicht an das bloße Öffnen.
   */
  function openTotpDialog(): void {
    setTotpDialogOpen(true);
    setTotpStep('start');
    setTotpSetupData(null);
    setTotpQrDataUrl(null);
    setTotpManualOpen(false);
    setTotpCode('');
    setTotpError(undefined);
    setEvidenceDialogError(undefined);
  }

  /** Fordert das Geheimnis an und zeigt den QR-Code. */
  async function setUpTotp(evidence?: SecondFactorEvidence): Promise<void> {
    setTotpLoading(true);
    setTotpError(undefined);
    setEvidenceDialogError(undefined);
    try {
      const setup = await totpSetup(evidence);
      setTotpSetupData(setup);
      setTotpQrDataUrl(
        await QRCode.toDataURL(setup.otpauthUrl, {
          margin: 0,
          width: 320,
        }),
      );
      setTotpStep('code');
      setEvidencePurpose(null);
    } catch (e) {
      if (await evidenceRequired(e, 'totp-setup', evidence)) return;
      setTotpError(
        errorText(e, t('einstellungen.totpSetupFailed')),
      );
    } finally {
      setTotpLoading(false);
    }
  }

  async function confirmTotp(): Promise<void> {
    setTotpLoading(true);
    setTotpError(undefined);
    try {
      await totpConfirm(totpCode);
      toast.show(t('einstellungen.totpSetUp'));
      setTotpDialogOpen(false);
      await reload();
    } catch (e) {
      setTotpError(
        e instanceof ApiError && e.status !== 401
          ? errorText(e, t('einstellungen.codeWrongRetry'))
          : t('einstellungen.codeWrongRetry'),
      );
    } finally {
      setTotpLoading(false);
    }
  }

  async function removeFactor(evidence?: SecondFactorEvidence): Promise<void> {
    if (!removeFor) return;
    setRemoveLoading(true);
    setRemoveError(null);
    setEvidenceDialogError(undefined);
    try {
      await factorRemove(removeFor, evidence);
      toast.show(
        removeFor === 'totp'
          ? t('einstellungen.totpRemoved')
          : t('einstellungen.emailCodeRemoved'),
      );
      setRemoveFor(null);
      setEvidencePurpose(null);
      // Der Server entwertet dabei alle Merk-Geräte — Liste und Stand neu holen.
      await loadDevices();
      await reload();
    } catch (e) {
      if (await evidenceRequired(e, 'factor-remove', evidence)) return;
      setRemoveError(
        errorText(e, t('einstellungen.methodRemoveFailed')),
      );
    } finally {
      setRemoveLoading(false);
    }
  }

  const openCodes = state?.openRecoveryCodes ?? 0;
  /** Nur wer bereits ein Passwort hat, muss das alte nachweisen. */
  const currentRequired = state?.passwordSet === true;
  const passwordSubmittable =
    newPasswordValid(newPassword, repeat) &&
    (!currentRequired || currentPassword.length > 0);

  const emailActive = state?.emailCodeSetUp === true;
  const totpActive = state?.totpSetUp === true;
  const passkeyCount = state?.passkeyCount ?? 0;

  /**
   * Die einzige eingerichtete Methode — oder null, wenn es mehr als eine gibt.
   *
   * Der Hinweis „Einzige Methode" ersetzt dann den „Entfernen"-Knopf
   * vollständig, statt ihn nur auszugrauen: Ein deaktivierter Knopf mit
   * `title` ist auf Touch-Geräten unsichtbar, ein dauerhafter Text nicht.
   * Durchgesetzt wird die Regel ohnehin serverseitig (`letzter_faktor`).
   */
  const setUpMethods = [
    ...(emailActive ? (['email'] as const) : []),
    ...(totpActive ? (['totp'] as const) : []),
    ...(passkeyCount > 0 ? (['passkey'] as const) : []),
  ];
  const lastMethod =
    setUpMethods.length === 1 ? setUpMethods[0] : null;

  /** Wäre dieser Passkey der letzte Zugang überhaupt? */
  function isLastAccess(g: DeviceEntry): boolean {
    return (
      g.kind === 'passkey' && passkeyCount <= 1 && !emailActive && !totpActive
    );
  }

  return (
    <section aria-labelledby="settings-title">
      <h1
        id="settings-title"
        className="text-2xl font-semibold tracking-tight text-text mb-1"
      >{t('einstellungen.title')}</h1>
      <p className="mb-4 text-sm text-leise">{t('einstellungen.intro')}</p>
      {viaPortal && (
        <p role="note" className="mb-4 text-sm text-leise">{t('sso.portalFactorsHint')}</p>
      )}

      {/* UNTER `sm` EINE AUSWAHLLISTE statt acht Chips: Acht Knöpfe brechen bei
          375 px in drei, vier Zeilen um (oder verschwinden hinter einem
          Seitwärtswischen); die Liste braucht eine Zeile, zeigt alle Bereiche
          auf einmal, hat von Haus aus 44 px Trefferfläche und eine
          Bedienung, die das Telefon schon kennt. Ab `sm` bleiben die Chips. */}
      {tabsInline ? (
        <FilterChips
          className="mb-5"
          label={t('einstellungen.sectionCaption')}
          active={tabs}
          onSelect={setTabs}
          chips={visibleTabs.map((r) => ({
            value: r.value,
            label: r.label,
            ...(r.value === 'devices' && devices !== null
              ? { count: devices.length }
              : {}),
          }))}
        />
      ) : (
        <div className="mb-5">
          <label htmlFor="settings-section" className="mb-1 block text-sm font-medium text-text">
            {t('einstellungen.sectionCaption')}
          </label>
          <Select
            id="settings-section"
            value={tabs}
            onChange={(e) => setTabs(e.target.value)}
            className="[&_select]:min-h-11"
          >
            {visibleTabs.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
                {r.value === 'devices' && devices !== null ? ` (${devices.length})` : ''}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* ============================================== Reiter „Geräte" */}
      {tabs === 'devices' && (
      <div>
      <h2 id="device-list" className="mb-3 text-lg font-semibold text-text">{t('einstellungen.devicesHeading')}</h2>
      {loadError ? (
        <div className="overflow-hidden rounded-xl border border-rahmen bg-flaeche p-6">
          <p className="mb-3 text-sm text-text" role="alert">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void loadDevices()}>{t('einstellungen.retry')}</Button>
        </div>
      ) : !devices ? (
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-rahmen bg-flaeche">
          <EmptyState
            Icon={Smartphone}
            title={t('einstellungen.devicesEmptyTitle')}
            notice={t('einstellungen.devicesEmptyHint')}
          />
        </div>
      ) : (
        <Table
          columns={COLUMNS}
          label={t('einstellungen.devicesTableCaption')}
        >
          {devices.map((g) => (
            <tr key={g.id} className="transition-colors hover:bg-flaeche-3">
              <td
                className={`${tableRow.compact} ${tableText.compact.primary}`}
              >
                {g.label}
              </td>
              <td
                className={`${tableRow.compact} ziffern-tabellarisch ${tableText.compact.secondary}`}
              >
                {formatDate(g.createdAt)}
              </td>
              <td
                className={`${tableRow.compact} ziffern-tabellarisch ${tableText.compact.secondary}`}
              >
                {g.lastSeenAt ? (
                  formatDate(g.lastSeenAt)
                ) : (
                  <span aria-label={t('einstellungen.notUsedYet')}>—</span>
                )}
              </td>
              <td
                className={`${tableRow.compact} ziffern-tabellarisch ${tableText.compact.secondary}`}
              >
                {g.validUntil ? (
                  formatDate(g.validUntil)
                ) : (
                  <span aria-label={t('einstellungen.noExpiry')}>—</span>
                )}
              </td>
              <td className={tableRow.compact}>
                <button
                  type="button"
                  title={t('einstellungen.revokeTitle')}
                  aria-label={t('einstellungen.revokeAriaLabel', { label: g.label })}
                  onClick={() => {
                    setRevocationError(null);
                    // Zweites Sicherheitsnetz neben dem Hinweis in
                    // „Anmeldemethoden": der letzte Zugang darf nicht weg.
                    if (isLastAccess(g)) {
                      setLastFactorFor(g);
                      return;
                    }
                    setRevocationFor(g);
                  }}
                  className="grid h-11 w-11 shrink-0 sm:h-9 sm:w-9 place-items-center rounded-lg border border-rahmen text-leise transition-colors hover:bg-flaeche-3 hover:text-text"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {devices && devices.length > 0 && (
        <p className="mt-2 text-xs text-leise md:hidden">{t('einstellungen.tableScrollHint')}</p>
      )}

      <div className="mt-3 flex flex-wrap items-start gap-3">
        {passkeysPossible() && (
          <PasskeyButton
            state={passkeyState}
            label={t('einstellungen.addAnotherPasskey')}
            loadingLabel={t('einstellungen.waitingForConfirmation')}
            errorText={passkeyError ?? undefined}
            onClick={() => {
              setEvidenceKind('password');
              setEvidencePassword('');
              setEvidenceCode('');
              setEvidenceError(undefined);
              setEvidenceOpen(true);
            }}
            variant="compact"
          />
        )}
        {devices !== null && (
          <Button
            variant="secondary"
            onClick={() => {
              setAllLogoutError(null);
              setAllLogoutOpen(true);
            }}
          >{t('einstellungen.signOutAllDevices')}</Button>
        )}
      </div>

      </div>
      )}

      {/* ========================================= Reiter „Zugangsdaten" */}
      {tabs === 'credentials' && (
      <div>
      <Card className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-text">{t('einstellungen.methodsHeading')}</h2>
        <p className="mb-4 text-sm text-leise">{t('einstellungen.methodsMinimumHint')}</p>
        <ul className="flex flex-col divide-y divide-rahmen">
          {/* Reihenfolge bewusst wie in der Ersteinrichtung: E-Mail, App,
              Passkey — dieselbe Abfolge an beiden Stellen. */}
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Mail
                className="h-5 w-5 shrink-0 text-primaer"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t('einstellungen.emailCodeTitle')}</p>
                <p className="text-xs text-leise">
                  {emailActive ? (
                    <>
                      {t('einstellungen.emailCodeActiveAt', { email: maskEmail(state?.loginCodeEmail ?? '') })}<button
                        type="button"
                        className={TEXT_BUTTON_TOUCH}
                        onClick={() => openEmailDialog('change')}
                      >{t('einstellungen.changeAddress')}</button>
                    </>
                  ) : (
                    t('einstellungen.notSetUp')
                  )}
                </p>
              </div>
            </div>
            {emailActive ? (
              lastMethod === 'email' ? (
                <p className="text-xs text-leise">{t('einstellungen.onlyMethodHint')}</p>
              ) : (
                <Button
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => {
                    setRemoveError(null);
                    setRemoveFor('email-code');
                  }}
                >{t('einstellungen.remove')}</Button>
              )
            ) : (
              <Button
                variant="secondaryGreen"
                className="shrink-0"
                onClick={() => openEmailDialog('add')}
              >{t('einstellungen.add')}</Button>
            )}
          </li>

          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <KeyRound
                className="h-5 w-5 shrink-0 text-primaer"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t('einstellungen.authenticatorApp')}</p>
                <p className="text-xs text-leise">
                  {totpActive ? (
                    <>
                      {/* [DW1]: Für einen AKTIVEN Faktor fehlte hier jeder Weg
                          zurück in den Dialog — es gab nur „Entfernen". Wer das
                          Telefon wechselt, musste den Faktor also erst abschaffen
                          und stand zwischenzeitlich mit einem weniger da. Der
                          Dialog selbst kann den Fall längst (er lässt die alte
                          App gelten, bis der neue Code bestätigt ist); es fehlte
                          allein die Tür. Dieselbe Bauform wie „Adresse ändern"
                          eine Zeile darüber. */}{t('einstellungen.setUp')}{' '}
                      <button
                        type="button"
                        className={TEXT_BUTTON_TOUCH}
                        onClick={openTotpDialog}
                      >{t('einstellungen.changeApp')}</button>
                    </>
                  ) : (
                    t('einstellungen.notSetUp')
                  )}
                </p>
              </div>
            </div>
            {totpActive ? (
              lastMethod === 'totp' ? (
                <p className="text-xs text-leise">{t('einstellungen.onlyMethodHint')}</p>
              ) : (
                <Button
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => {
                    setRemoveError(null);
                    setRemoveFor('totp');
                  }}
                >{t('einstellungen.remove')}</Button>
              )
            ) : (
              <Button
                variant="secondaryGreen"
                className="shrink-0"
                onClick={openTotpDialog}
              >{t('einstellungen.add')}</Button>
            )}
          </li>

          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Fingerprint
                className="h-5 w-5 shrink-0 text-primaer"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t('einstellungen.passkey')}</p>
                <p className="text-xs text-leise">
                  {passkeyCount > 0
                    ? t('einstellungen.passkeysSetUp', { count: passkeyCount })
                    : t('einstellungen.notSetUp')}
                </p>
              </div>
            </div>
            {/* Kein eigener Knopf: Welchen Passkey ein „Entfernen" hier
                träfe, wäre bei mehreren nicht zu sagen. Hinzufügen und
                Widerruf leben in der Geräteliste, hier steht nur der
                Sprunglink dorthin. */}
            <button
              type="button"
              className={`shrink-0 text-sm ${TEXT_BUTTON_TOUCH}`}
              onClick={() =>
                document
                  .getElementById('device-list')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
            >{t('einstellungen.manageInDeviceList')}</button>
          </li>
        </ul>
      </Card>

      {/* --- Passwort ----------------------------------------------------- */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-lg font-semibold text-text">{t('einstellungen.changePasswordHeading')}</h2>
        <p className="mb-4 text-sm text-leise">{t('auth.rememberedDevicesHint')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void updatePassword();
          }}
          noValidate
        >
          {currentRequired && (
            <InputField
              id="aktuelles-passwort"
              label={t('einstellungen.currentPasswordLabel')}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              error={errorCurrent}
              disabled={passwordLoading}
            />
          )}
          <PasswordWithStrength
            value={newPassword}
            onValueChange={setNewPassword}
            repeatValue={repeat}
            onRepeatChange={setRepeat}
            strength={passwordStrength(newPassword)}
            errorRepeat={errorRepeat}
            onRepeatLeave={() =>
              setErrorRepeat(
                repeat.length > 0 && newPassword !== repeat
                  ? t('einstellungen.passwordsMismatch')
                  : undefined,
              )
            }
            disabled={passwordLoading}
          />
          {passwordError && (
            <p role="alert" className="mb-4 text-sm text-gefahr">
              {passwordError}
            </p>
          )}
          <Button
            type="submit"
            loading={passwordLoading}
            disabled={!passwordSubmittable}
          >{t('einstellungen.changePasswordHeading')}</Button>
        </form>
      </Card>

      </div>
      )}

      {/* =========================================== Reiter „Sicherheit" */}
      {tabs === 'security' && (
      <div>
      {/* Portal-Sitzung: Wiederherstellungscodes (2FA der lokalen Anmeldung) gibt es
          hier nicht, die Faktoren verwaltet das Portal. */}
      {!viaPortal && (
      <Card className="p-6">
        {codes ? (
          <>
            <h2 className="mb-4 text-lg font-semibold text-text">{t('einstellungen.recoveryCodesHeading')}</h2>
            <RecoveryCodeList
              codes={codes}
              confirmed={codesConfirmed}
              onConfirmedChange={setCodesConfirmed}
              onPrint={() => window.print()}
              onCopy={async () => {
                await navigator.clipboard.writeText(codes.join('\n'));
                toast.show(t('einstellungen.copiedToClipboard'));
              }}
            />
            <div className="mt-4 print:hidden">
              <Button
                disabled={!codesConfirmed}
                onClick={() => {
                  setCodes(null);
                  setCodesConfirmed(false);
                }}
              >{t('einstellungen.acknowledge')}</Button>
            </div>
          </>
        ) : (
          // Unter 640 px gestapelt: nebeneinander lief der Knopf über den
          // Kartenrand hinaus und sein Text brach in vier gequetschte Zeilen um
          // (Finding W1-neu). Ab `sm` bleibt die Zeile wie zuvor.
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text">{t('einstellungen.recoveryCodesHeading')}</h2>
              <p className="mt-1 text-sm text-leise">
                <Badge className="bg-flaeche-3 text-text">
                  {t('einstellungen.recoveryCodesRemaining', { open: openCodes })}</Badge>
              </p>
              {codesError && (
                <p role="alert" className="mt-2 text-sm text-gefahr">
                  {codesError}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              className="shrink-0 self-start"
              onClick={() => setNewCreateOpen(true)}
            >{t('einstellungen.createNewCodes')}</Button>
          </div>
        )}
      </Card>
      )}

      {!staff && <VaultSecurityCard />}

      <SecurityLog className="mt-6" />
      </div>
      )}

      {/* Rolle „Mitarbeit": die Reiter mit Schreibzugriff bleiben lesbar, alle
          Felder und Knöpfe darin sind gesperrt (der Server antwortet ohnehin
          mit `forbidden_role`). */}
      {staff && ['user', 'features', 'company', 'prices', 'backup'].includes(tabs) && (
        <p role="note" className="mb-4 text-sm text-leise">{t('sso.staffReadOnly')}</p>
      )}
      <fieldset disabled={staff} className="m-0 min-w-0 border-0 p-0">
      {/* =============================================== Reiter „Nutzer" */}
      {tabs === 'user' && (
      <div>
        <UserManagement />
      </div>
      )}

      {/* ============================================ Reiter „Funktionen" */}
      {tabs === 'features' && <FeatureFlagManagement />}

      {/* ============================================ Reiter „Firmendaten" */}
      {tabs === 'company' && <IssuerProfileCard />}

      {/* ================================================ Reiter „Preise" */}
      {tabs === 'prices' && <PricesCard totpPossible={state?.totpSetUp ?? false} />}

      {/* =============================================== Reiter „Sicherung" */}
      {tabs === 'backup' && <BackupSettingsCard totpPossible={state?.totpSetUp ?? false} />}
      </fieldset>

      {/* --- Dialoge ------------------------------------------------------ */}
      <Dialog
        open={emailDialog !== null && evidencePurpose !== 'email-code'}
        title={
          emailDialog === 'change'
            ? t('einstellungen.emailDialogTitleChange')
            : t('einstellungen.emailDialogTitleAdd')
        }
        size="sm"
        onClose={() => setEmailDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmailDialog(null)}>{t('einstellungen.cancel')}</Button>
            {emailStep === 'start' ? (
              <Button
                loading={emailSendLoading}
                disabled={
                  emailDialog === 'change' && newEmail.trim().length === 0
                }
                onClick={() => void sendEmailCode()}
              >{t('einstellungen.sendCode')}</Button>
            ) : (
              <Button
                loading={emailLoading}
                disabled={emailCode.length !== 8}
                onClick={() => void confirmEmailCode()}
              >
                {emailDialog === 'change' ? t('einstellungen.save') : t('einstellungen.confirm')}
              </Button>
            )}
          </>
        }
      >
        {emailStep === 'start' ? (
          <>
            {emailDialog === 'change' ? (
              <>
                <p className="mb-4 text-leise">
                  {t('einstellungen.emailChangeNotice', { email: maskEmail(state?.loginCodeEmail ?? '') })}</p>
                <InputField
                  id="anmeldecode-email"
                  label={t('einstellungen.newEmailLabel')}
                  type="email"
                  autoComplete="email"
                  helperText={t('einstellungen.newEmailHelper')}
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  error={emailError}
                  disabled={emailSendLoading}
                />
              </>
            ) : (
              <>
                <p className="mb-4 text-leise">
                  {t('einstellungen.emailSetupNotice', { email: maskEmail(state?.loginCodeEmail ?? ''), hint: t('auth.codeValidHint') })}</p>
                {emailError && (
                  <p role="alert" className="text-sm text-gefahr">
                    {emailError}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <p className="mb-4 text-leise">
              {t('einstellungen.emailCodePrompt', { hint: t('auth.codeValidHint') })}</p>
            <EmailCodeInput
              value={emailCode}
              onValueChange={setEmailCode}
              error={emailError}
              disabled={emailLoading}
            />
            {/* Verlangt die Meldung oben einen neuen Code, muss hier auch der
                Weg dorthin stehen — nicht nur eine Wartezeit. */}
            <div className="text-sm">
              {emailCooldownRest > 0 ? (
                <span className="text-leise">
                  {newCodeRequired
                    ? t('einstellungen.requestNewCodeIn')
                    : t('einstellungen.resendIn')}
                  <span className="ziffern-tabellarisch">
                    {emailCooldownRest}
                  </span>{' '}{t('einstellungen.secondsUnit')}</span>
              ) : (
                <button
                  type="button"
                  className={TEXT_BUTTON_TOUCH}
                  onClick={() => void sendEmailCode()}
                >
                  {newCodeRequired
                    ? t('einstellungen.requestNewCode')
                    : t('einstellungen.resendCode')}
                </button>
              )}
            </div>
          </>
        )}
      </Dialog>

      {/* Ein Dialog für alle drei Aktionen, die einen Nachweis verlangen.
          `totpMoeglich` fällt beim Entfernen der Authenticator-App bewusst weg:
          Sie mit sich selbst zu bestätigen und im selben Zug abzuschaffen wäre
          ein Weg, der sich unter den Füßen wegzieht. */}
      <SecondFactorEvidenceDialog
        open={evidencePurpose !== null}
        title={t('einstellungen.verifyTitle')}
        declaration={
          evidencePurpose ? EVIDENCE_EXPLANATION[evidencePurpose] : ''
        }
        totpPossible={
          totpActive &&
          !(evidencePurpose === 'factor-remove' && removeFor === 'totp')
        }
        loading={
          emailSendLoading ||
          totpLoading ||
          codesLoading ||
          removeLoading ||
          revocationLoading
        }
        error={evidenceDialogError}
        onCancel={() => {
          setEvidencePurpose(null);
          setEvidenceDialogError(undefined);
        }}
        onConfirm={(evidence) => {
          if (evidencePurpose === 'email-code') void sendEmailCode(evidence);
          else if (evidencePurpose === 'totp-setup')
            void setUpTotp(evidence);
          else if (evidencePurpose === 'codes-new') void createCodes(evidence);
          else if (evidencePurpose === 'factor-remove')
            void removeFactor(evidence);
          else if (evidencePurpose === 'passkey-revoke')
            void confirmRevocation(evidence);
        }}
      />

      <Dialog
        open={totpDialogOpen && evidencePurpose !== 'totp-setup'}
        title={
          totpActive ? t('einstellungen.totpDialogTitleChange') : t('einstellungen.totpDialogTitleAdd')
        }
        size="sm"
        onClose={() => setTotpDialogOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTotpDialogOpen(false)}>{t('einstellungen.cancel')}</Button>
            {totpStep === 'start' ? (
              <Button loading={totpLoading} onClick={() => void setUpTotp()}>{t('einstellungen.showQrCode')}</Button>
            ) : (
              <Button
                loading={totpLoading}
                disabled={totpCode.length !== 6 || !totpSetupData}
                onClick={() => void confirmTotp()}
              >{t('einstellungen.confirm')}</Button>
            )}
          </>
        }
      >
        {totpStep === 'start' ? (
          <>
            <p className="mb-4 text-leise">{t('einstellungen.totpIntro')}</p>
            {totpActive && (
              <p className="mb-4 text-sm text-leise">{t('einstellungen.totpKeepOldHint')}</p>
            )}
            {totpError && (
              <p role="alert" className="text-sm text-gefahr">
                {totpError}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mb-4 text-leise">{t('einstellungen.totpScanPrompt')}</p>
            {!totpSetupData ? (
              totpError ? (
                <p role="alert" className="text-sm text-gefahr">
                  {totpError}
                </p>
              ) : (
                <Spinner text={t('einstellungen.secretLoading')} />
              )
            ) : (
          <>
            {totpQrDataUrl && (
              <div className="mx-auto mb-4 grid h-48 w-48 place-items-center rounded-lg border border-rahmen bg-flaeche-2 p-4">
                <img
                  src={totpQrDataUrl}
                  alt={t('einstellungen.qrAlt')}
                  className="h-full w-full"
                />
              </div>
            )}
            <button
              type="button"
              aria-expanded={totpManualOpen}
              onClick={() => setTotpManualOpen((open) => !open)}
              className={`mb-2 flex items-center gap-1 text-sm ${TEXT_BUTTON}`}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform duration-150 ${
                  totpManualOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />{t('einstellungen.manualEntryToggle')}</button>
            {totpManualOpen && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2">
                <code className="font-mono text-sm tracking-widest text-text">
                  {inGroupsOfFour(totpSetupData.secretBase32)}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      totpSetupData.secretBase32,
                    );
                    toast.show(t('einstellungen.copiedToClipboard'));
                  }}
                  aria-label={t('einstellungen.copySecret')}
                  className="rounded-md p-1.5 text-leise hover:bg-flaeche-3 hover:text-text"
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
                <TotpInput
                  label={t('einstellungen.totpCodeLabel')}
                  value={totpCode}
                  onValueChange={setTotpCode}
                  error={totpError}
                  disabled={totpLoading}
                />
              </>
            )}
          </>
        )}
      </Dialog>

      <Dialog
        open={removeFor !== null && evidencePurpose !== 'factor-remove'}
        title={
          removeFor === 'totp'
            ? t('einstellungen.removeTotpTitle')
            : t('einstellungen.removeEmailTitle')
        }
        size="sm"
        onClose={() => setRemoveFor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveFor(null)}>{t('einstellungen.cancel')}</Button>
            <Button
              variant="danger"
              loading={removeLoading}
              onClick={() => void removeFactor()}
            >{t('einstellungen.remove')}</Button>
          </>
        }
      >
        <p>
          {removeFor === 'totp'
            ? t('einstellungen.removeTotpBody')
            : t('einstellungen.removeEmailBody')}
        </p>
        <p className="mt-3 text-sm text-leise">{t('auth.factorRemoveHint')}</p>
        {removeError && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {removeError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={lastFactorFor !== null}
        title={t('einstellungen.lastMethodTitle')}
        size="sm"
        onClose={() => setLastFactorFor(null)}
        footer={
          <Button variant="ghost" onClick={() => setLastFactorFor(null)}>{t('einstellungen.understood')}</Button>
        }
      >
        {lastFactorFor && (
          <p>
            {t('einstellungen.lastMethodBody', { label: lastFactorFor.label })}
          </p>
        )}
      </Dialog>

      <Dialog
        open={evidenceOpen}
        title={t('einstellungen.addPasskeyTitle')}
        size="sm"
        onClose={() => setEvidenceOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEvidenceOpen(false)}>{t('einstellungen.cancel')}</Button>
            <Button
              loading={passkeyState === 'loading'}
              disabled={
                evidenceKind === 'password'
                  ? evidencePassword.length === 0
                  : evidenceCode.length !== 6
              }
              onClick={() =>
                void addPasskey(
                  evidenceKind === 'password'
                    ? { currentPassword: evidencePassword }
                    : { totpCode: evidenceCode },
                )
              }
            >{t('einstellungen.next')}</Button>
          </>
        }
      >
        <p className="mb-4 text-leise">{t('einstellungen.passkeyIntro')}</p>
        {evidenceKind === 'password' ? (
          <>
            <InputField
              id="nachweis-passwort"
              label={t('einstellungen.currentPasswordLabel')}
              type="password"
              autoComplete="current-password"
              value={evidencePassword}
              onChange={(e) => setEvidencePassword(e.target.value)}
              error={evidenceError}
              disabled={passkeyState === 'loading'}
            />
            {/* Der Server nimmt als Nachweis nur Passwort oder TOTP an — wer
                keine Authenticator-App hat, bekommt diesen Umweg gar nicht
                erst angeboten. */}
            {totpActive && (
              <button
                type="button"
                className={`text-sm ${TEXT_BUTTON}`}
                onClick={() => {
                  setEvidenceKind('totp');
                  setEvidenceError(undefined);
                }}
              >{t('einstellungen.useTotpInstead')}</button>
            )}
          </>
        ) : (
          <>
            <TotpInput
              value={evidenceCode}
              onValueChange={setEvidenceCode}
              error={evidenceError}
              disabled={passkeyState === 'loading'}
            />
            <button
              type="button"
              className={`text-sm ${TEXT_BUTTON}`}
              onClick={() => {
                setEvidenceKind('password');
                setEvidenceError(undefined);
              }}
            >{t('einstellungen.usePasswordInstead')}</button>
          </>
        )}
      </Dialog>

      <Dialog
        open={allLogoutOpen}
        title={t('einstellungen.signOutAllTitle')}
        size="sm"
        onClose={() => setAllLogoutOpen(false)}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setAllLogoutOpen(false)}
            >{t('einstellungen.cancel')}</Button>
            <Button
              variant="danger"
              loading={allLogoutLoading}
              onClick={() => void handleSignOutAll()}
            >{t('einstellungen.signOutAll')}</Button>
          </>
        }
      >
        <p>{t('einstellungen.signOutAllBody')}</p>
        {allLogoutError && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {allLogoutError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={revocationFor !== null && evidencePurpose !== 'passkey-revoke'}
        title={t('einstellungen.revokeDeviceTitle')}
        size="sm"
        onClose={() => setRevocationFor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevocationFor(null)}>{t('einstellungen.cancel')}</Button>
            <Button
              variant="danger"
              loading={revocationLoading}
              onClick={() => void confirmRevocation()}
            >{t('einstellungen.revoke')}</Button>
          </>
        }
      >
        {revocationFor && (
          <p>
            {revocationFor.kind === 'passkey'
              ? t('einstellungen.revokePasskeyBody', { label: revocationFor.label })
              : t('einstellungen.signOutDeviceBody', { label: revocationFor.label })}
          </p>
        )}
        {revocationError && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {revocationError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={newCreateOpen && evidencePurpose !== 'codes-new'}
        title={t('einstellungen.newCodesTitle')}
        size="sm"
        onClose={() => setNewCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewCreateOpen(false)}>{t('einstellungen.cancel')}</Button>
            <Button
              variant="danger"
              loading={codesLoading}
              onClick={() => void createCodes()}
            >{t('einstellungen.create')}</Button>
          </>
        }
      >
        <p>{t('einstellungen.newCodesBody')}</p>
      </Dialog>
    </section>
  );
}
