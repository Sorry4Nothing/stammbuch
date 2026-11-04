/** Domänentypen und Ports des Auth-Moduls. Persistenz und Mail nur über diese Schnittstellen. */

export type Role = "user" | "chief_admin";

export interface User {
  id: string;
  /** Normalisiert (trim, Kleinbuchstaben). */
  email: string;
  role: Role;
  /** `<pepperId>:<argon2id-PHC-String>`, siehe password.ts. */
  passwordHash: string;
  /** TOTP-Geheimnis, verschlüsselt (secretbox.ts). `null` = 2FA noch nicht eingerichtet. */
  totpSecretEnc: string | null;
  /** Letzter akzeptierter TOTP-Zeitschritt (Replay-Schutz). */
  totpLastCounter: number | null;
  /** HMAC der unverbrauchten Wiederherstellungscodes. Klartext wird nie gespeichert. */
  recoveryCodeHashes: string[];
  disabled: boolean;
  createdAt: Date;
}

export interface Session {
  /** SHA-256 des Cookie-Tokens. Das Token selbst wird nie gespeichert. */
  id: string;
  userId: string;
  /** `pending` = Passwort geprüft, zweiter Faktor fehlt. Nur `full` gibt Zugriff. */
  stage: "pending" | "full";
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** Absolutes Ablaufdatum, unabhängig von Aktivität. */
  expiresAt: Date;
  /** Verschlüsseltes, noch nicht bestätigtes TOTP-Geheimnis während der Einrichtung. */
  pendingTotpSecretEnc: string | null;
  failedMfaAttempts: number;
}

export interface ThrottleState {
  failures: number;
  lastFailureAt: Date;
  lockedUntil: Date | null;
}

export type AuditEventType =
  | "login_success"
  | "login_failure"
  | "login_locked"
  | "mfa_success"
  | "mfa_failure"
  | "mfa_replay"
  | "mfa_enrolled"
  | "recovery_used"
  | "recovery_failure"
  | "logout"
  | "password_changed"
  | "password_change_failure"
  | "mfa_reset"
  | "mfa_reset_denied"
  | "csrf_rejected"
  | "session_rejected"
  | "notice_failed";

export interface AuditEvent {
  at: Date;
  type: AuditEventType;
  outcome: "success" | "failure";
  actorUserId: string | null;
  targetUserId: string | null;
  ip: string;
  /** Nur unkritische Werte (keine Passwörter, Codes, Tokens, Klartext-E-Mails). */
  detail?: Record<string, string | number | boolean>;
}

/** Alle Operationen, bei denen Rennen Sicherheit kosten würden, sind atomar (CAS). */
export interface UserRepo {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  setPasswordHash(id: string, hash: string): Promise<void>;
  /** Nur wenn noch kein TOTP gesetzt ist. `false` = bereits eingerichtet. */
  enrollTotp(
    id: string,
    secretEnc: string,
    counter: number,
    recoveryHashes: string[],
  ): Promise<boolean>;
  /** Löscht TOTP-Geheimnis, Zähler und Wiederherstellungscodes (Chef-Admin-Reset). */
  clearTotp(id: string): Promise<void>;
  /** Setzt den Zähler nur, wenn `counter` grösser als der gespeicherte ist. */
  advanceTotpCounter(id: string, counter: number): Promise<boolean>;
  /** Entfernt den Hash atomar. `false` = unbekannt oder schon verbraucht. */
  consumeRecoveryCode(id: string, hash: string): Promise<boolean>;
}

export interface SessionRepo {
  create(session: Session): Promise<void>;
  findById(id: string): Promise<Session | null>;
  touch(id: string, lastSeenAt: Date): Promise<void>;
  setPendingTotp(id: string, secretEnc: string): Promise<void>;
  /** Erhöht den Fehlversuchszähler atomar und liefert den neuen Wert. */
  recordMfaFailure(id: string): Promise<number>;
  revoke(id: string): Promise<void>;
  /** Widerruft alle Sitzungen des Nutzers, optional ausser einer. */
  revokeAllForUser(userId: string, exceptId?: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

/** Sperrzähler pro Konto-Schlüssel (HMAC der E-Mail), auch für nicht existierende Konten. */
export interface ThrottleRepo {
  get(key: string): Promise<ThrottleState | null>;
  /** Transaktionales Lesen-Ändern-Schreiben. */
  update(key: string, fn: (prev: ThrottleState | null) => ThrottleState): Promise<ThrottleState>;
  clear(key: string): Promise<void>;
}

export interface AuditRepo {
  append(event: AuditEvent): Promise<void>;
  list(filter?: { userId?: string; limit?: number }): Promise<AuditEvent[]>;
}

export type SecurityNotice =
  | { kind: "mfa_reset"; to: string; at: Date }
  | { kind: "mfa_enrolled"; to: string; at: Date }
  | { kind: "password_changed"; to: string; at: Date }
  | { kind: "recovery_used"; to: string; at: Date; remaining: number };

/** Sicherheitsmeldungen an Nutzer. Die SMTP-Anbindung folgt mit dem Mail-Modul. */
export interface MailPort {
  sendSecurityNotice(notice: SecurityNotice): Promise<void>;
}

/** Abgleich gegen Listen bekannter/geleakter Passwörter (SR-06). */
export interface PasswordBlocklist {
  isBlocked(password: string): Promise<boolean>;
}
