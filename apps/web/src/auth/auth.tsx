import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Dauer der Sitzung bis zur erneuten Anmeldung (Design 2.7: «Nach 8 Stunden»). */
export const SESSION_HOURS = 8;

export interface Session {
  name: string;
  email: string;
  organization: string;
  /** Beginn der Sitzung, Millisekunden seit 1970. */
  startedAt: number;
}

export interface LockInfo {
  email: string;
  since: number;
  until: number;
  failedAttempts: number;
  /** Wodurch die Sperre ausgelöst wurde. */
  cause: "password" | "code";
}

export type SignInResult =
  | { status: "otp_required"; recoveryCodes?: { left: number; total: number } }
  | { status: "invalid"; remainingAttempts: number }
  | { status: "locked"; lock: LockInfo };

export type CodeResult =
  | { status: "ok"; session: Session }
  | { status: "invalid"; remainingAttempts: number }
  | { status: "locked"; lock: LockInfo };

/**
 * Schnittstelle zum Anmelde-Backend. Die Oberfläche kennt nur diesen Vertrag; die
 * Umsetzung gegen die API folgt im Auth-Issue. Netzwerkfehler als Exception werfen.
 */
export interface AuthService {
  signIn: (email: string, password: string) => Promise<SignInResult>;
  verifyCode: (code: string) => Promise<CodeResult>;
  verifyRecovery: (code: string) => Promise<CodeResult>;
  /** Erneute Anmeldung nach abgelaufener Sitzung (Passwort und Einmalcode). */
  reauthenticate: (password: string, code: string) => Promise<CodeResult>;
  signOut: () => Promise<void>;
}

/** Vorgabe, solange kein Backend angebunden ist: jede Anfrage schlägt fehl. */
export const unavailableAuthService: AuthService = {
  signIn: () => Promise.reject(new Error("auth backend missing")),
  verifyCode: () => Promise.reject(new Error("auth backend missing")),
  verifyRecovery: () => Promise.reject(new Error("auth backend missing")),
  reauthenticate: () => Promise.reject(new Error("auth backend missing")),
  signOut: () => Promise.resolve(),
};

interface AuthApi {
  service: AuthService;
  session: Session | null;
  setSession: (session: Session | null) => void;
  /** E-Mail-Adresse zwischen Passwort- und Code-Schritt. */
  pendingEmail: string | null;
  setPendingEmail: (email: string | null) => void;
  recoveryCodes: { left: number; total: number } | null;
  setRecoveryCodes: (info: { left: number; total: number } | null) => void;
  lock: LockInfo | null;
  setLock: (lock: LockInfo | null) => void;
  /** Sitzung abgelaufen (Design 2.7). Vom API-Client bei 401 aufzurufen. */
  expired: boolean;
  markExpired: () => void;
  signOut: () => Promise<void>;
  /** Aktuelle Uhrzeit, minütlich aktualisiert. */
  now: number;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({
  service = unavailableAuthService,
  initialSession = null,
  children,
}: {
  service?: AuthService;
  initialSession?: Session | null;
  children: ReactNode;
}) {
  const [session, setSessionState] = useState<Session | null>(initialSession);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<{ left: number; total: number } | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [expired, setExpired] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const markExpired = useCallback(() => setExpired(true), []);

  // Die Sitzung endet nach SESSION_HOURS; der Server entscheidet verbindlich (401).
  useEffect(() => {
    if (session && now - session.startedAt >= SESSION_HOURS * 3_600_000) setExpired(true);
  }, [now, session]);

  const setSession = useCallback((next: Session | null) => {
    setSessionState(next);
    if (next) setExpired(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await service.signOut();
    } finally {
      setSessionState(null);
      setExpired(false);
      setPendingEmail(null);
    }
  }, [service]);

  const api = useMemo<AuthApi>(
    () => ({
      service,
      session,
      setSession,
      pendingEmail,
      setPendingEmail,
      recoveryCodes,
      setRecoveryCodes,
      lock,
      setLock,
      expired,
      markExpired,
      signOut,
      now,
    }),
    [
      service,
      session,
      setSession,
      pendingEmail,
      recoveryCodes,
      lock,
      expired,
      markExpired,
      signOut,
      now,
    ],
  );
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth braucht einen AuthProvider");
  return ctx;
}
