/** Domänentypen und Ports des Auth-Moduls. Persistenz und Mail nur über diese Schnittstellen. */

export type Role = "user" | "chief_admin";

export interface User {
  id: string;
  /** Kunde (Mandant) des Benutzers. Kommt aus der Datenbank, nie aus dem Request (SR-13). */
  tenantId: string;
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
  tenantId: string;
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
  | "recovery_codes_renewed"
  | "stepup_failure"
  | "recovery_failure"
  | "logout"
  | "password_changed"
  | "password_change_failure"
  | "mfa_reset"
  | "mfa_reset_denied"
  | "invitation_redeemed"
  | "invitation_rejected"
  | "csrf_rejected"
  | "session_rejected"
  | "notice_failed";

export interface AuditEvent {
  at: Date;
  /** Mandant, in dessen Protokoll das Ereignis gehört. `null` = Mandant unbekannt (z. B. unbekanntes Konto). */
  tenantId: string | null;
  type: AuditEventType;
  outcome: "success" | "failure";
  actorUserId: string | null;
  targetUserId: string | null;
  ip: string;
  /** Nur unkritische Werte (keine Passwörter, Codes, Tokens, Klartext-E-Mails). */
  detail?: Record<string, string | number | boolean>;
}

/**
 * Alle Operationen, bei denen Rennen Sicherheit kosten würden, sind atomar (CAS). Alles, was einen
 * Benutzer oder eine Sitzung ändert, bekommt den Mandanten mit (aus der aufgelösten Sitzung, nie aus dem Request).
 */
export interface UserRepo {
  /** Anmeldung: noch ohne Mandant. */
  findByEmail(email: string): Promise<User | null>;
  findById(tenantId: string, id: string): Promise<User | null>;
  /**
   * Chef-Admin-Reset: Ziel in einem beliebigen Mandanten. `null`, wenn es das Ziel nicht gibt oder
   * `actorId` kein aktiver Chef-Admin ist (prüft die Datenquelle, nicht nur der Aufrufer).
   */
  findForMfaReset(actorId: string, targetId: string): Promise<User | null>;
  setPasswordHash(tenantId: string, id: string, hash: string): Promise<void>;
  /** Nur wenn noch kein TOTP gesetzt ist. `false` = bereits eingerichtet. */
  enrollTotp(
    tenantId: string,
    id: string,
    secretEnc: string,
    counter: number,
    recoveryHashes: string[],
  ): Promise<boolean>;
  /** Löscht TOTP-Geheimnis, Zähler und Wiederherstellungscodes (Chef-Admin-Reset). */
  clearTotp(tenantId: string, id: string): Promise<void>;
  /** Setzt den Zähler nur, wenn `counter` grösser als der gespeicherte ist. */
  advanceTotpCounter(tenantId: string, id: string, counter: number): Promise<boolean>;
  /** Entfernt den Hash atomar. `false` = unbekannt oder schon verbraucht. */
  consumeRecoveryCode(tenantId: string, id: string, hash: string): Promise<boolean>;
  /** Ersetzt alle Wiederherstellungscodes atomar (alte sind sofort wertlos). */
  replaceRecoveryCodes(tenantId: string, id: string, hashes: string[]): Promise<void>;
}

/**
 * Einladungen einlösen (Issue #56). Das Token kommt nur als SHA-256-Hash an. Abgelaufen, schon benutzt oder
 * unbekannt ist für beide Methoden dasselbe: `null`, ohne Grund.
 */
export interface InvitationRepo {
  /** Nur lesen: Adresse und Kunde einer gültigen Einladung (für die Passwortregeln und den Mandanten der Transaktion). */
  peek(tokenHash: string, now: Date): Promise<{ email: string; tenantId: string } | null>;
  /**
   * Atomar: Einladung verbrauchen, Passwort setzen, Benutzer aktivieren bzw. den ersten Admin des Kunden
   * anlegen. Scheitert ein Schritt, bleibt die Einladung unverbraucht. Aktive Konten bleiben unberührt.
   * `role` ist die Kundenrolle aus der Einladung.
   */
  redeem(
    tokenHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<{ userId: string; tenantId: string; role: "admin" | "user" } | null>;
}

export interface SessionRepo {
  create(session: Session): Promise<void>;
  /** Löst ein Token (SHA-256-Hash) auf; noch ohne Mandant. Abgelaufene oder widerrufene: `null`. */
  findById(id: string): Promise<Session | null>;
  touch(tenantId: string, id: string, lastSeenAt: Date): Promise<void>;
  setPendingTotp(tenantId: string, id: string, secretEnc: string): Promise<void>;
  /** Erhöht den Fehlversuchszähler atomar und liefert den neuen Wert. */
  recordMfaFailure(tenantId: string, id: string): Promise<number>;
  revoke(tenantId: string, id: string): Promise<void>;
  /** Widerruft alle Sitzungen des Nutzers, optional ausser einer. */
  revokeAllForUser(tenantId: string, userId: string, exceptId?: string): Promise<void>;
  /** Wartung über alle Mandanten. */
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
  /** Mit `tenantId` nur dieser Mandant (die Postgres-Variante verlangt ihn). */
  list(filter?: { tenantId?: string; userId?: string; limit?: number }): Promise<AuditEvent[]>;
}

export type SecurityNotice =
  | { kind: "mfa_reset"; to: string; at: Date }
  | { kind: "mfa_enrolled"; to: string; at: Date }
  | { kind: "password_changed"; to: string; at: Date }
  | { kind: "recovery_used"; to: string; at: Date; remaining: number }
  | { kind: "recovery_codes_renewed"; to: string; at: Date };

/** Sicherheitsmeldungen an Nutzer. Die SMTP-Anbindung folgt mit dem Mail-Modul. */
export interface MailPort {
  sendSecurityNotice(notice: SecurityNotice): Promise<void>;
}

/** Abgleich gegen Listen bekannter/geleakter Passwörter (SR-06). */
export interface PasswordBlocklist {
  isBlocked(password: string): Promise<boolean>;
}
