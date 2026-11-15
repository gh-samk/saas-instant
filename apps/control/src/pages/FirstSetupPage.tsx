import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Mail,
} from 'lucide-react';
import { InputField, Card, Button, Spinner, useToast } from '@saas-instant/ui';
import { PasswordWithStrength } from '../components/PasswordWithStrength';
import { PasskeyButton } from '../components/PasskeyButton';
import type { PasskeyState } from '../components/PasskeyButton';
import { StepIndicator } from '../components/StepIndicator';
import { EmailCodeInput } from '../components/EmailCodeInput';
import { TotpInput } from '../components/TotpInput';
import { RecoveryCodeList } from '../components/RecoveryCodeList';
import { SecondFactorSelect } from '../components/SecondFactorSelect';
import { SecondFactorEvidenceDialog } from '../components/SecondFactorEvidenceDialog';
import type { SecondFactorMethod } from '../components/SecondFactorSelect';
import { useAuth } from '../context/AuthContext';
import {
  CODE_AGAIN_AFTER_SECONDS,
  emailCodeConfirm,
  emailCodeSetup,
  emergencyEnrollmentComplete,
  emergencyEnrollmentStart,
  passkeyEnrollmentComplete,
  passkeyEnrollmentStart,
  passwordSet,
  totpConfirm,
  totpSetup,
  recoveryCodesNew,
} from '../lib/api';
import {
  ApiError,
  loginCodeWaitSecondsFrom,
  errorText,
  blockSecondsFrom,
} from '../lib/api-client';
import { asMinutesSeconds, useCountdown } from '../lib/countdown';
import { emailCodeMessageFrom } from '../lib/email-code-error';
import { TEXT_BUTTON } from '../lib/styles';
import {
  newPasswordValid,
  passwordStrength,
} from '../lib/password-strength';
import { maskEmail } from '../utils/email-mask';
import { passkeyEnrollment, passkeysPossible } from '../lib/webauthn';
import type { TotpSetup, SecondFactorEvidence } from '../lib/api';
import { useT, t } from '../i18n';

/**
 * Schritt 2 heißt je nach gewählter Methode anders. Solange nichts gewählt ist,
 * steht dort der Oberbegriff — die Schrittzeile soll nicht „Authenticator-App"
 * behaupten, während gerade noch die Wahl offensteht.
 */
const NAMES_SECOND_FACTOR: Record<'choice' | SecondFactorMethod, string> = {
  choice: t('ersteinrichtung.secondFactor'),
  email: t('ersteinrichtung.emailCode'),
  totp: t('ersteinrichtung.authenticatorApp'),
  passkey: t('ersteinrichtung.passkey'),
};

/** Die Schritte des Wizards. Welche davon vorkommen, hängt von der Wahl ab. */
type StepKey = 'password' | 'factor' | 'passkey' | 'codes';

const STEP_TITLE: Record<StepKey, string> = {
  password: t('ersteinrichtung.password'),
  factor: t('ersteinrichtung.secondFactor'),
  passkey: t('ersteinrichtung.passkey'),
  codes: t('ersteinrichtung.recoveryCodes'),
};

/** Gruppiert das TOTP-Geheimnis in Viererblöcke (bessere Abtippbarkeit). */
function inGroupsOfFour(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

export function FirstSetupPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { state, reload } = useAuth();
  const [searchParams] = useSearchParams();
  const emergencyToken = searchParams.get('token') ?? '';

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  /**
   * Gab es in diesem Durchlauf schon einmal einen geladenen Stand?
   *
   * Danach bedeutet ein fehlender Stand etwas völlig anderes als davor: nicht
   * „lädt noch", sondern „die Sitzung ist weg". Ohne diese Unterscheidung fiel
   * die Seite auf den Notfall-Vorschritt zurück und zeigte dessen
   * stehengebliebenes „Passkey erfolgreich erstellt" — ein Bildschirm, der
   * Erfolg behauptet, während nichts mehr geht (Finding K3).
   */
  const [stateSeen, setStateSeen] = useState(false);

  // Notfall-Registrierlink
  const [linkState, setLinkState] = useState<PasskeyState>('idle');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);

  // Schritt 1 (Passwort)
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [errorRepeat, setErrorRepeat] = useState<string>();
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordEdit, setPasswordEdit] = useState(false);

  // Schritt 2 (zweiter Faktor: Wahl und Unterweg)
  const [method, setMethod] = useState<SecondFactorMethod | null>(null);
  /** Zeigt die Methodenwahl, obwohl bereits ein Faktor eingerichtet ist. */
  const [selectionForced, setSelectionForced] = useState(false);

  // Schritt 2, Unterweg TOTP
  const [totp, setTotp] = useState<TotpSetup | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [totpDone, setTotpDone] = useState(false);

  // Schritt 2, Unterweg E-Mail-Code
  const [emailSent, setEmailSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [sendLoading, setSendLoading] = useState(false);
  const [emailDone, setEmailDone] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  const [cooldownRound, setCooldownRound] = useState(0);
  const cooldown = useCountdown(cooldownSeconds, cooldownRound);
  /** Der gehaltene Code ist verbrannt oder abgelaufen — es braucht einen neuen. */
  const [newCodeRequired, setNewCodeRequired] = useState(false);
  /**
   * Wofür der Server gerade einen Zweitfaktor-Nachweis verlangt.
   *
   * Im Wizard trifft das nur, wer lange auf einem Schritt stehenbleibt: Bei
   * einer Sitzung unter 10 Minuten fragt der Server gar nicht, und frisch
   * angemeldet ist hier jeder.
   */
  const [evidencePurpose, setEvidencePurpose] = useState<
    'email-code' | 'totp-setup' | 'codes-new' | null
  >(null);
  const [evidenceError, setEvidenceError] = useState<string>();

  // Schritt 3 (Passkey)
  const [passkeyState, setPasskeyState] = useState<PasskeyState>('idle');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  // Schritt 4 (Wiederherstellungscodes)
  const [codes, setCodes] = useState<string[] | null>(null);
  const [codesConfirmed, setCodesConfirmed] = useState(false);
  const [codesError, setCodesError] = useState<string | null>(null);

  /**
   * Hat der Wizard auf diesem Schritt schon einmal VON SELBST angefordert?
   *
   * [DK1] — die Endlosschleife. Die beiden Automatik-Effekte unten hatten
   * `stand` in ihrer Abhängigkeitsliste. `stand` ist ein frisches Objekt aus
   * jedem `neuLaden()`, und `neuLaden()` läuft genau dann, wenn eine Anfrage
   * mit 401 zurückkam. Damit stand die Schleife: anfordern → 401 → Stand
   * nachladen → neues Objekt → Abhängigkeit geändert → anfordern. Sichtbar
   * wurde das erst nach zehn Minuten Sitzungsalter, weil der Server vorher gar
   * keinen Nachweis verlangt — genau die Spanne, die jemand beim Abtippen von
   * Wiederherstellungscodes leicht überschreitet. Gemessen: rund 99 Anfragen,
   * danach war die ganze Anwendung minutenlang im globalen Rate-Limit.
   *
   * Ein Ref und keine Zustandsvariable: der Wert darf keinen Rerender
   * auslösen, sonst ist er selbst wieder Teil der Schleife.
   *
   * Zurückgesetzt wird beim Verlassen des Unterwegs (`zurueckZurMethodenwahl`)
   * und über „Erneut versuchen" — die Automatik soll einmal je Betreten
   * laufen, nicht einmal je Sitzung.
   */
  const totpRequested = useRef(false);
  const codesRequested = useRef(false);

  useEffect(() => {
    if (state) setStateSeen(true);
  }, [state]);

  /** Der Server hat die Sitzung verworfen, während der Wizard lief. */
  const sessionLost = stateSeen && !state;

  const totpAlreadySetUp = state?.totpSetUp === true;
  const emailAlreadySetUp = state?.emailCodeSetUp === true;

  /**
   * Die Schrittfolge ist NICHT fest vierstellig.
   *
   * Wer in Schritt 2 den Passkey als zweiten Faktor wählt, hat den optionalen
   * Passkey-Schritt damit schon erledigt — er würde sonst als zweiter,
   * gleichnamiger Schritt direkt daneben stehen („2 Passkey · 3 Passkey").
   * Der Schritt entfällt dann ganz, statt umbenannt zu werden: Es gibt nichts
   * mehr zu tun, und aus vier Schritten werden ehrlich drei.
   */
  const stepSequence: StepKey[] =
    method === 'passkey'
      ? ['password', 'factor', 'codes']
      : ['password', 'factor', 'passkey', 'codes'];
  // Fällt der Passkey-Schritt weg, während die Person weiter hinten steht,
  // liefe der Index sonst über das Listenende hinaus — und die Schrittzeile
  // zeigte „Schritt 4 von 3". Der gekappte Index gilt überall, nicht nur hier.
  const stepIndex = Math.min(step, stepSequence.length - 1);
  const current: StepKey = stepSequence[stepIndex] ?? 'password';

  const stepNames = stepSequence.map((key) =>
    key === 'factor'
      ? NAMES_SECOND_FACTOR[method ?? 'choice']
      : STEP_TITLE[key],
  );


  /**
   * Nach jedem 401 den Stand nachladen.
   *
   * Ein 401 ist im Wizard mehrdeutig — falsches Passwort, falscher Code,
   * fehlender Zweitfaktor-Nachweis ODER tote Sitzung. Statt das je Aufrufstelle
   * zu erraten, fragt die Oberfläche den Server: Fällt der Stand auf null, ist
   * die Sitzung wirklich weg und der Bildschirm ganz oben übernimmt. Lebt sie,
   * bleibt es bei der örtlichen Meldung.
   */
  const checkSession = useCallback(
    async (e: unknown): Promise<void> => {
      if (e instanceof ApiError && e.status === 401) {
        await reload().catch(() => undefined);
      }
    },
    [reload],
  );

  /**
   * Behandelt ein 401 auf einer Route, die einen Nachweis verlangen kann.
   *
   * Erst den Stand nachladen: Ist die Sitzung tot, übernimmt der Bildschirm
   * ganz oben, statt den Dialog in eine Schleife aus „Passwort ist falsch"
   * laufen zu lassen. Gibt `true` zurück, wenn nichts weiter anzuzeigen ist.
   */
  const evidenceRequired = useCallback(
    async (
      e: unknown,
      purpose: 'email-code' | 'totp-setup' | 'codes-new',
      evidence: SecondFactorEvidence | undefined,
    ): Promise<boolean> => {
      if (!(e instanceof ApiError) || e.status !== 401) return false;
      await reload().catch(() => undefined);
      if (evidence) {
        setEvidenceError(
          evidence.totpCode !== undefined
            ? t('ersteinrichtung.codeWrongRetry')
            : t('ersteinrichtung.currentPasswordWrong'),
        );
      } else {
        setEvidencePurpose(purpose);
      }
      return true;
    },
    [reload],
  );

  /**
   * Erzeugt ein neues TOTP-Geheimnis samt QR-Code.
   *
   * Das Geheimnis ist bis zur Bestätigung nur vorläufig — ein abgebrochener
   * Versuch lässt einen bereits eingerichteten Authenticator unberührt.
   */
  const startTotp = useCallback(
    async (evidence?: SecondFactorEvidence) => {
      setLoading(true);
      setTotpError(undefined);
      setEvidenceError(undefined);
      try {
        const setup = await totpSetup(evidence);
        setTotp(setup);
        setQrDataUrl(
          await QRCode.toDataURL(setup.otpauthUrl, { margin: 0, width: 320 }),
        );
        setTotpDone(false);
        setEvidencePurpose(null);
      } catch (e) {
        if (await evidenceRequired(e, 'totp-setup', evidence)) return;
        setTotpError(
          errorText(e, t('ersteinrichtung.totpSetupFailed')),
        );
      } finally {
        setLoading(false);
      }
    },
    [evidenceRequired],
  );

  // Beim Betreten des TOTP-Unterwegs ein Geheimnis anfordern — aber nur, wenn
  // noch keines hinterlegt ist: ein neuer Aufruf würde ein funktionierendes
  // TOTP entwerten. Und genau EINMAL je Betreten, siehe `totpAngefordert`.
  useEffect(() => {
    if (current !== 'factor' || method !== 'totp') return;
    if (totp || totpAlreadySetUp || !state) return;
    if (totpRequested.current) return;
    totpRequested.current = true;
    void startTotp();
  }, [current, method, totp, totpAlreadySetUp, state, startTotp]);

  /** Fordert die acht Codes an; bei 401 mit Nachweis. */
  const fetchCodes = useCallback(
    async (evidence?: SecondFactorEvidence) => {
      setLoading(true);
      setEvidenceError(undefined);
      try {
        const response = await recoveryCodesNew(evidence);
        setCodes(response.codes);
        setCodesError(null);
        setEvidencePurpose(null);
      } catch (e) {
        if (await evidenceRequired(e, 'codes-new', evidence)) return;
        setCodesError(
          errorText(e, t('ersteinrichtung.codesCreateFailed')),
        );
      } finally {
        setLoading(false);
      }
    },
    [evidenceRequired],
  );

  // Die acht Codes werden genau einmal angefordert und im Wizard gehalten.
  // „Genau einmal" stand hier schon immer als Absicht — durchgesetzt wird es
  // erst durch `codesAngefordert` ([DK1]).
  useEffect(() => {
    if (current !== 'codes' || codes || !state) return;
    if (codesRequested.current) return;
    codesRequested.current = true;
    void fetchCodes();
  }, [current, codes, state, fetchCodes]);

  async function redeemLink(): Promise<void> {
    setLinkState('loading');
    setLinkError(null);
    try {
      const start = await emergencyEnrollmentStart(emergencyToken);
      if (!start.valid || !start.options) {
        setLinkInvalid(true);
        setLinkState('idle');
        return;
      }
      const response = await passkeyEnrollment(start.options);
      await emergencyEnrollmentComplete(emergencyToken, response);
      await reload();
      setLinkState('success');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        setLinkInvalid(true);
        setLinkState('idle');
        return;
      }
      setLinkError(t('ersteinrichtung.passkeyCreateFailed'));
      setLinkState('error');
    }
  }

  /** Setzt das Passwort und geht weiter. Aufgerufen vom Footer-Knopf „Weiter". */
  async function setPasswordAndNext(): Promise<void> {
    const passwordAlreadySet = state?.passwordSet === true;
    setLoading(true);
    setPasswordError(null);
    try {
      await passwordSet(
        password,
        passwordAlreadySet ? currentPassword : undefined,
      );
      await reload();
      setPassword('');
      setRepeat('');
      setCurrentPassword('');
      setPasswordEdit(false);
      setStep(1);
    } catch (e) {
      await checkSession(e);
      const seconds = blockSecondsFrom(e);
      if (seconds !== null) {
        setPasswordError(
          t('ersteinrichtung.blockedRetry', { time: asMinutesSeconds(seconds) }),
        );
        return;
      }
      setPasswordError(
        passwordAlreadySet && e instanceof ApiError && e.status === 401
          ? t('ersteinrichtung.currentPasswordWrong')
          : errorText(e, t('ersteinrichtung.passwordSetFailed')),
      );
    } finally {
      setLoading(false);
    }
  }

  async function checkTotpAndNext(): Promise<void> {
    if (totpAlreadySetUp && !totp) {
      setStep(2);
      return;
    }
    setLoading(true);
    setTotpError(undefined);
    try {
      await totpConfirm(totpCode);
      setTotpDone(true);
      await reload();
      setStep(2);
    } catch (e) {
      await checkSession(e);
      setTotpError(
        e instanceof ApiError && e.status !== 401
          ? errorText(e, t('ersteinrichtung.codeWrongRetry'))
          : t('ersteinrichtung.codeWrongRetry'),
      );
    } finally {
      setLoading(false);
    }
  }

  /**
   * Fordert einen Einrichtungscode an. Anders als beim Anmelden liefert der
   * Server hier bei zu frühem Anfordern eine echte Restzeit — die wird
   * übernommen, statt blind bei 60 zu beginnen. Sonst zeigte ein zweiter Tab
   * „jetzt möglich", während der Server noch ablehnt.
   */
  async function sendSetupCode(
    evidence?: SecondFactorEvidence,
  ): Promise<void> {
    setSendLoading(true);
    setEmailError(undefined);
    setEvidenceError(undefined);
    try {
      await emailCodeSetup(undefined, evidence);
      setEmailCode('');
      setEmailSent(true);
      setNewCodeRequired(false);
      setEvidencePurpose(null);
      setCooldownSeconds(CODE_AGAIN_AFTER_SECONDS);
      setCooldownRound((r) => r + 1);
    } catch (e) {
      const wait = loginCodeWaitSecondsFrom(e);
      if (wait !== null) {
        // Ein Code ist bereits unterwegs — das Feld darf trotzdem erscheinen.
        setEmailSent(true);
        setEvidencePurpose(null);
        setCooldownSeconds(wait);
        setCooldownRound((r) => r + 1);
        return;
      }
      // Der Server verlangt einen Zweitfaktor-Nachweis, sobald die Sitzung
      // älter als 10 Minuten ist. Erst versuchen, dann fragen — in der
      // frischen Ersteinrichtung soll niemand grundlos sein Passwort tippen.
      if (await evidenceRequired(e, 'email-code', evidence)) return;
      setEmailError(
        errorText(e, t('ersteinrichtung.codeSendFailed')),
      );
    } finally {
      setSendLoading(false);
    }
  }

  async function checkEmailCodeAndNext(): Promise<void> {
    if (emailAlreadySetUp && !emailSent) {
      setStep(2);
      return;
    }
    setLoading(true);
    setEmailError(undefined);
    try {
      await emailCodeConfirm(emailCode);
      setEmailDone(true);
      await reload();
      setStep(2);
    } catch (e) {
      await checkSession(e);
      // `detail.grund` trennt Tippfehler, verbrannten und abgelaufenen Code.
      const { text, newCodeRequired: deadCode } = emailCodeMessageFrom(e);
      // Ohne Grund (kein Code hinterlegt) hat der Server hier einen
      // brauchbaren Wortlaut — anders als auf dem Anmeldeweg.
      setEmailError(text ?? errorText(e, t('ersteinrichtung.codeWrongRetry')));
      setNewCodeRequired(deadCode);
      if (deadCode) setEmailCode('');
    } finally {
      setLoading(false);
    }
  }

  async function createPasskey(): Promise<void> {
    setPasskeyState('loading');
    setPasskeyError(null);
    try {
      const { options } = await passkeyEnrollmentStart();
      const response = await passkeyEnrollment(options);
      await passkeyEnrollmentComplete(response);
      await reload();
      setPasskeyState('success');
    } catch (e) {
      // Ein 401 ist hier zweideutig: tote Sitzung ODER fehlender
      // Zweitfaktor-Nachweis bei einer Sitzung über 10 Minuten. Deshalb erst
      // den Stand nachladen — ist er weg, übernimmt der Bildschirm ganz oben.
      // Der Fehler wird in jedem Fall gesetzt, sonst scheiterte der Klick
      // stumm, wenn die Sitzung doch noch lebt.
      await checkSession(e);
      setPasskeyError(
        t('ersteinrichtung.passkeyCreateFailed'),
      );
      setPasskeyState('error');
    }
  }

  async function copySecret(): Promise<void> {
    if (!totp) return;
    await navigator.clipboard.writeText(totp.secretBase32);
    toast.show(t('ersteinrichtung.copiedToClipboard'));
  }

  async function copyCodes(): Promise<void> {
    if (!codes) return;
    await navigator.clipboard.writeText(codes.join('\n'));
    toast.show(t('ersteinrichtung.copiedToClipboard'));
  }

  /** Zurück zur Methodenwahl, bevor etwas bestätigt wurde. */
  function backToMethodChoice(): void {
    setMethod(null);
    setSelectionForced(true);
    setTotpError(undefined);
    setEmailError(undefined);
    // Wer den Unterweg verlässt und später wiederkommt, soll die Automatik
    // erneut bekommen — die Sperre gilt je Betreten, nicht je Sitzung ([DK1]).
    totpRequested.current = false;
  }

  /**
   * „Erneut versuchen" nach einem abgebrochenen oder gescheiterten
   * Automatik-Aufruf. Ohne diesen Weg bliebe ein Schritt, dessen automatische
   * Anfrage einmal fehlschlug, dauerhaft leer — vorher fiel das nicht auf,
   * weil die Automatik unbegrenzt weiterlief.
   */
  function retryTotpAgain(): void {
    totpRequested.current = true;
    void startTotp();
  }

  function retryCodesAgain(): void {
    codesRequested.current = true;
    setCodesError(null);
    void fetchCodes();
  }

  // --- Notfall-Registrierlink: Vorschritt vor dem Wizard --------------------

  // Vor allen anderen Zweigen: ein toter Zugang darf nicht als Erfolg
  // durchgehen. Der Weg hinaus steht als Knopf da, nicht nur als Text.
  if (sessionLost) {
    return (
      <Frame subtitle={t('ersteinrichtung.sessionEndedSubtitle')}>
        <Card className="p-6 sm:p-8">
          <div className="flex items-start gap-3 text-left">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-gefahr"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-text" role="alert">{t('ersteinrichtung.sessionEndedTitle')}</p>
              <p className="mt-1 text-sm text-leise">{t('ersteinrichtung.sessionEndedBody')}</p>
            </div>
          </div>
          <div className="mt-4">
            <Button onClick={() => navigate('/login')}>{t('ersteinrichtung.toLogin')}</Button>
          </div>
        </Card>
      </Frame>
    );
  }

  if (!state && emergencyToken) {
    return (
      <Frame>
        <Card className="p-6 sm:p-8">
          {linkInvalid ? (
            <div className="flex items-start gap-3 text-left">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-gefahr"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-semibold text-text">{t('ersteinrichtung.linkInvalidTitle')}</p>
                <p className="mt-1 text-sm text-leise">{t('ersteinrichtung.linkInvalidBody')}</p>
              </div>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.passkeyIntro')}</p>
              {passkeysPossible() ? (
                <PasskeyButton
                  state={linkState}
                  label={t('ersteinrichtung.passkeyCreate')}
                  loadingLabel={t('ersteinrichtung.passkeyWaiting')}
                  successLabel={t('ersteinrichtung.passkeyCreated')}
                  errorText={linkError ?? undefined}
                  onClick={() => void redeemLink()}
                  variant="large"
                />
              ) : (
                <p role="alert" className="text-sm text-gefahr">{t('ersteinrichtung.passkeyUnsupported')}</p>
              )}
            </>
          )}
        </Card>
      </Frame>
    );
  }

  if (!state) {
    return (
      <Frame>
        <Card className="p-6 sm:p-8">
          <Spinner text={t('ersteinrichtung.accountLoading')} />
        </Card>
      </Frame>
    );
  }

  // --- Wizard ---------------------------------------------------------------

  const passwordFormVisible = !state.passwordSet || passwordEdit;
  const factorsPresent = state.setUpFactors.length > 0;
  /** Die Methodenwahl steht offen — dann gibt es noch kein „Weiter". */
  const selectionShow =
    method === null && (!factorsPresent || selectionForced);

  const nextPossible = (() => {
    if (current === 'password') {
      // Ohne sichtbares Formular ist das Passwort bereits gesetzt — dann geht
      // es einfach weiter, ohne dass etwas geschickt wird.
      if (!passwordFormVisible) return true;
      if (state.passwordSet && currentPassword.length === 0) return false;
      return newPasswordValid(password, repeat);
    }
    if (current === 'factor') {
      if (method === null) return !selectionShow && factorsPresent;
      if (method === 'totp') {
        if (totpAlreadySetUp && !totp) return true;
        return totpCode.length === 6 && !!totp;
      }
      if (method === 'email') {
        if (emailAlreadySetUp && !emailSent) return true;
        return emailSent && emailCode.length === 8;
      }
      return passkeyState === 'success' || state.passkeyCount > 0;
    }
    if (current === 'passkey') return true;
    return codesConfirmed;
  })();

  /** Der „Weiter"-Knopf prüft je nach Unterweg etwas anderes. */
  function next(): void {
    if (current === 'password' && passwordFormVisible) {
      void setPasswordAndNext();
      return;
    }
    if (current === 'factor' && method === 'totp') {
      void checkTotpAndNext();
      return;
    }
    if (current === 'factor' && method === 'email') {
      void checkEmailCodeAndNext();
      return;
    }
    setStep((s) => s + 1);
  }

  const isChecked =
    loading && (current === 'password' || (current === 'factor' && method !== 'passkey'));

  return (
    <Frame step={stepIndex} stepNames={stepNames}>
      <StepIndicator steps={stepNames} activeIndex={stepIndex} />
      <Card className="mt-6 p-6 sm:p-8">
        {current === 'password' && (
          <div className="text-left">
            <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.passwordIntro')}</p>

            {!passwordFormVisible ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                  <CheckCircle2
                    className="h-5 w-5 text-primaer"
                    aria-hidden="true"
                  />{t('ersteinrichtung.passwordSet')}</div>
                <button
                  type="button"
                  className={`mt-2 text-sm ${TEXT_BUTTON}`}
                  onClick={() => {
                    setPassword('');
                    setRepeat('');
                    setCurrentPassword('');
                    setErrorRepeat(undefined);
                    setPasswordError(null);
                    setPasswordEdit(true);
                  }}
                >{t('ersteinrichtung.changePassword')}</button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void setPasswordAndNext();
                }}
                noValidate
              >
                {state.passwordSet && (
                  <>
                    <InputField
                      id="aktuelles-passwort"
                      label={t('ersteinrichtung.currentPasswordLabel')}
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      disabled={loading}
                    />
                    <p className="mb-4 text-sm text-leise">
                      {t('auth.rememberedDevicesHint')}
                    </p>
                  </>
                )}
                <PasswordWithStrength
                  value={password}
                  onValueChange={setPassword}
                  repeatValue={repeat}
                  onRepeatChange={setRepeat}
                  strength={passwordStrength(password)}
                  errorRepeat={errorRepeat}
                  onRepeatLeave={() =>
                    setErrorRepeat(
                      repeat.length > 0 && password !== repeat
                        ? t('ersteinrichtung.passwordsMismatch')
                        : undefined,
                    )
                  }
                  disabled={loading}
                />
                {passwordError && (
                  <p role="alert" className="text-sm text-gefahr">
                    {passwordError}
                  </p>
                )}
                {/* Absenden läuft über den Footer-Knopf „Weiter"; dieser
                    versteckte Knopf hält die Eingabetaste im Formular am
                    Leben, ohne eine zweite sichtbare Hauptaktion zu erzeugen. */}
                <button type="submit" className="sr-only" tabIndex={-1}>{t('ersteinrichtung.setPassword')}</button>
              </form>
            )}
          </div>
        )}

        {current === 'factor' && (
          <div className="text-left">
            {selectionShow && (
              <>
                <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.secondFactorIntro')}</p>
                <SecondFactorSelect
                  value={method}
                  onValueChange={setMethod}
                  passkeyAvailable={passkeysPossible()}
                />
                {factorsPresent && (
                  <button
                    type="button"
                    className={`mt-3 text-sm ${TEXT_BUTTON}`}
                    onClick={() => setSelectionForced(false)}
                  >{t('ersteinrichtung.cancel')}</button>
                )}
              </>
            )}

            {method === null && !selectionShow && (
              <>
                <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.secondFactorExists')}</p>
                <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                  <CheckCircle2
                    className="h-5 w-5 shrink-0 text-primaer"
                    aria-hidden="true"
                  />
                  {t('ersteinrichtung.setUpFactors', { names: nameFactors(state.setUpFactors) })}</div>
                <button
                  type="button"
                  className={`mt-2 text-sm ${TEXT_BUTTON}`}
                  onClick={() => setSelectionForced(true)}
                >{t('ersteinrichtung.setUpAnotherMethod')}</button>
              </>
            )}

            {method === 'totp' && (
              <>
                <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.totpIntro')}</p>

                {totpAlreadySetUp && !totp ? (
                  <>
                    <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                      <CheckCircle2
                        className="h-5 w-5 shrink-0 text-primaer"
                        aria-hidden="true"
                      />{t('ersteinrichtung.totpSetUp')}</div>
                    <button
                      type="button"
                      className={`mt-2 text-sm ${TEXT_BUTTON}`}
                      onClick={() => void startTotp()}
                    >{t('ersteinrichtung.setUpAgain')}</button>
                  </>
                ) : !totp ? (
                  totpError ? (
                    <>
                      <p role="alert" className="text-sm text-gefahr">
                        {totpError}
                      </p>
                      <button
                        type="button"
                        className={`mt-2 text-sm ${TEXT_BUTTON}`}
                        onClick={retryTotpAgain}
                      >{t('ersteinrichtung.retry')}</button>
                    </>
                  ) : (
                    <Spinner text={t('ersteinrichtung.secretLoading')} />
                  )
                ) : (
                  <>
                    {qrDataUrl && (
                      <div className="mx-auto mb-4 grid h-48 w-48 place-items-center rounded-lg border border-rahmen bg-flaeche-2 p-4">
                        <img
                          src={qrDataUrl}
                          alt={t('ersteinrichtung.qrAlt')}
                          className="h-full w-full"
                        />
                      </div>
                    )}

                    <button
                      type="button"
                      aria-expanded={manualOpen}
                      onClick={() => setManualOpen((open) => !open)}
                      className={`mb-2 flex items-center gap-1 text-sm ${TEXT_BUTTON}`}
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform duration-150 ${
                          manualOpen ? 'rotate-180' : ''
                        }`}
                        aria-hidden="true"
                      />{t('ersteinrichtung.manualEntryToggle')}</button>
                    {manualOpen && (
                      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2">
                        <code className="font-mono text-sm tracking-widest text-text">
                          {inGroupsOfFour(totp.secretBase32)}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copySecret()}
                          aria-label={t('ersteinrichtung.copySecret')}
                          className="rounded-md p-1.5 text-leise hover:bg-flaeche-3 hover:text-text"
                        >
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    )}

                    {totpDone ? (
                      <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                        <CheckCircle2
                          className="h-5 w-5 shrink-0 text-primaer"
                          aria-hidden="true"
                        />{t('ersteinrichtung.totpConfirmed')}</div>
                    ) : (
                      <TotpInput
                        label={t('ersteinrichtung.totpCodeLabel')}
                        value={totpCode}
                        onValueChange={setTotpCode}
                        error={totpError}
                        disabled={loading}
                      />
                    )}
                  </>
                )}
                <OtherMethod onChoose={backToMethodChoice} />
              </>
            )}

            {method === 'email' && (
              <>
                <p className="mb-4 text-sm text-leise">
                  {t('ersteinrichtung.emailCodeFuture', { email: maskEmail(state.loginCodeEmail) })}</p>

                {emailAlreadySetUp && !emailSent ? (
                  <>
                    <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                      <CheckCircle2
                        className="h-5 w-5 shrink-0 text-primaer"
                        aria-hidden="true"
                      />{t('ersteinrichtung.emailCodeSetUp')}</div>
                    <button
                      type="button"
                      className={`mt-2 text-sm ${TEXT_BUTTON}`}
                      onClick={() => void sendSetupCode()}
                    >{t('ersteinrichtung.confirmAgain')}</button>
                  </>
                ) : emailDone ? (
                  <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                    <CheckCircle2
                      className="h-5 w-5 shrink-0 text-primaer"
                      aria-hidden="true"
                    />{t('ersteinrichtung.emailCodeConfirmed')}</div>
                ) : !emailSent ? (
                  <>
                    <div className="mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3">
                      <Mail
                        className="mt-0.5 h-5 w-5 shrink-0 text-primaer"
                        aria-hidden="true"
                      />
                      <p className="text-sm text-leise">
                        {t('ersteinrichtung.emailCodeSendNotice', { hint: t('auth.codeValidHint') })}</p>
                    </div>
                    <Button
                      onClick={() => void sendSetupCode()}
                      loading={sendLoading}
                      className="w-full justify-center py-3 text-base"
                    >{t('ersteinrichtung.sendCode')}</Button>
                    {emailError && (
                      <p role="alert" className="mt-3 text-sm text-gefahr">
                        {emailError}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <EmailCodeInput
                      label={t('ersteinrichtung.emailCodeLabel')}
                      value={emailCode}
                      onValueChange={setEmailCode}
                      error={emailError}
                      disabled={loading}
                    />
                    {/* Verlangt die Meldung oben einen neuen Code, muss hier
                        auch der Weg dorthin stehen — nicht nur eine Wartezeit. */}
                    <div className="text-sm">
                      {cooldown > 0 ? (
                        <span className="text-leise">
                          {newCodeRequired
                            ? t('ersteinrichtung.requestNewCodeIn')
                            : t('ersteinrichtung.resendIn')}
                          <span className="ziffern-tabellarisch">
                            {cooldown}
                          </span>{' '}{t('ersteinrichtung.secondsUnit')}</span>
                      ) : (
                        <button
                          type="button"
                          className={TEXT_BUTTON}
                          onClick={() => void sendSetupCode()}
                        >
                          {newCodeRequired
                            ? t('ersteinrichtung.requestNewCode')
                            : t('ersteinrichtung.resendCode')}
                        </button>
                      )}
                    </div>
                  </>
                )}
                <OtherMethod onChoose={backToMethodChoice} />
              </>
            )}

            {method === 'passkey' && (
              <>
                <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.passkeyExplanation')}</p>
                {state.passkeyCount > 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                    <CheckCircle2
                      className="h-5 w-5 shrink-0 text-primaer"
                      aria-hidden="true"
                    />{t('ersteinrichtung.passkeySetUp')}</div>
                ) : (
                  <PasskeyButton
                    state={passkeyState}
                    label={t('ersteinrichtung.passkeyCreate')}
                    loadingLabel={t('ersteinrichtung.passkeyWaiting')}
                    successLabel={t('ersteinrichtung.passkeyCreated')}
                    errorText={passkeyError ?? undefined}
                    onClick={() => void createPasskey()}
                    variant="large"
                  />
                )}
                <OtherMethod onChoose={backToMethodChoice} />
              </>
            )}
          </div>
        )}

        {current === 'passkey' && (
          <div className="text-left">
            <p className="mb-4 text-sm text-leise">{t('ersteinrichtung.passkeyOptionalIntro')}</p>
            {!passkeysPossible() ? (
              <p className="text-sm text-leise">{t('ersteinrichtung.passkeyUnsupportedSkip')}</p>
            ) : state.passkeyCount > 0 ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-sm text-text">
                  <CheckCircle2
                    className="h-5 w-5 shrink-0 text-primaer"
                    aria-hidden="true"
                  />{t('ersteinrichtung.passkeySetUp')}</div>
                <div className="mt-3">
                  <PasskeyButton
                    state={passkeyState}
                    label={t('ersteinrichtung.addAnotherPasskey')}
                    loadingLabel={t('ersteinrichtung.passkeyWaiting')}
                    errorText={passkeyError ?? undefined}
                    onClick={() => void createPasskey()}
                    variant="compact"
                  />
                </div>
              </>
            ) : (
              <PasskeyButton
                state={passkeyState}
                label={t('ersteinrichtung.passkeyCreate')}
                loadingLabel={t('ersteinrichtung.passkeyWaiting')}
                successLabel={t('ersteinrichtung.passkeyCreated')}
                errorText={passkeyError ?? undefined}
                onClick={() => void createPasskey()}
                variant="large"
              />
            )}
            <p className="mt-2 text-sm text-leise">{t('ersteinrichtung.passkeySkipHint')}</p>
          </div>
        )}

        {current === 'codes' && (
          <div className="text-left">
            {codesError ? (
              <>
                <p role="alert" className="text-sm text-gefahr">
                  {codesError}
                </p>
                <button
                  type="button"
                  className={`mt-2 text-sm ${TEXT_BUTTON}`}
                  onClick={retryCodesAgain}
                >{t('ersteinrichtung.retry')}</button>
              </>
            ) : !codes ? (
              <Spinner text={t('ersteinrichtung.codesGenerating')} />
            ) : (
              <RecoveryCodeList
                codes={codes}
                confirmed={codesConfirmed}
                onConfirmedChange={setCodesConfirmed}
                onPrint={() => window.print()}
                onCopy={copyCodes}
              />
            )}
          </div>
        )}
      </Card>

      <div className="mt-6 flex justify-between print:hidden">
        {step > 0 && (
          <Button
            variant="secondary"
            onClick={() => setStep((s) => s - 1)}
            disabled={loading}
          >{t('ersteinrichtung.back')}</Button>
        )}
        <div className={step === 0 ? 'ml-auto' : ''}>
          {current === 'codes' ? (
            <Button
              onClick={() => navigate('/')}
              disabled={!nextPossible}
              loading={loading}
            >{t('ersteinrichtung.finishSetup')}</Button>
          ) : (
            // In der offenen Methodenwahl gibt es bewusst kein „Weiter": Der
            // Klick auf eine Karte ist die Handlung, kein zweiter Klick nötig.
            !(current === 'factor' && selectionShow) && (
              <Button
                onClick={next}
                disabled={!nextPossible}
                loading={loading}
              >
                {isChecked ? t('ersteinrichtung.checking') : t('ersteinrichtung.next')}
              </Button>
            )
          )}
        </div>
      </div>
      <SecondFactorEvidenceDialog
        open={evidencePurpose !== null}
        title={t('ersteinrichtung.verifyTitle')}
        declaration={t('ersteinrichtung.verifyExplanation')}
        totpPossible={totpAlreadySetUp}
        loading={loading || sendLoading}
        error={evidenceError}
        onCancel={() => {
          // Ohne Nachweis kommt der abgebrochene Vorgang nicht weiter. Das
          // muss dastehen: vorher lief die Automatik einfach weiter und die
          // Seite zeigte einen Spinner, hinter dem 99 Anfragen abgingen ([DK1]).
          if (evidencePurpose === 'totp-setup' && !totp) {
            setTotpError(
              t('ersteinrichtung.totpNeedsVerification'),
            );
          }
          if (evidencePurpose === 'codes-new' && !codes) {
            setCodesError(
              t('ersteinrichtung.codesNeedVerification'),
            );
          }
          setEvidencePurpose(null);
          setEvidenceError(undefined);
        }}
        onConfirm={(evidence) => {
          if (evidencePurpose === 'email-code')
            void sendSetupCode(evidence);
          else if (evidencePurpose === 'totp-setup') void startTotp(evidence);
          else if (evidencePurpose === 'codes-new') void fetchCodes(evidence);
        }}
      />
    </Frame>
  );
}

/** Rückweg zur Methodenwahl, in allen drei Unterwegen gleich. */
function OtherMethod({ onChoose }: { onChoose: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`mt-3 block text-sm ${TEXT_BUTTON}`}
      onClick={onChoose}
    >{t('ersteinrichtung.chooseOtherMethod')}</button>
  );
}

/** „Code per E-Mail und Passkey" — für die Zeile „Eingerichtet: …". */
function nameFactors(factors: readonly string[]): string {
  const names: Record<string, string> = {
    'email-code': t('ersteinrichtung.emailCode'),
    totp: t('ersteinrichtung.authenticatorApp'),
    passkey: t('ersteinrichtung.passkey'),
  };
  const list = factors.map((f) => names[f] ?? f);
  if (list.length <= 1) return list[0] ?? '';
  return t('ersteinrichtung.listJoin', { head: list.slice(0, -1).join(', '), last: list[list.length - 1] });
}

/** Gemeinsamer Rahmen: Titel, Schrittzeile, zentrierte Spalte. */
function Frame({
  step,
  stepNames,
  subtitle = t('ersteinrichtung.redeemLinkFirst'),
  children,
}: {
  step?: number;
  stepNames?: string[];
  /** Zeile unter dem Titel, solange es keine Schrittzählung gibt. */
  subtitle?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex min-h-dvh justify-center bg-flaeche-2 px-4 py-8">
      <div className="w-full max-w-xl">
        <h1 className="mb-1 font-serif text-2xl font-bold text-primaer">{t('ersteinrichtung.title')}</h1>
        {step === undefined || !stepNames ? (
          <p className="mb-6 text-sm text-leise">{subtitle}</p>
        ) : (
          <p className="mb-6 text-sm text-leise">
            {t('ersteinrichtung.stepOf', { step: step + 1, total: stepNames.length, name: stepNames[step] })}</p>
        )}
        {children}
      </div>
    </div>
  );
}
