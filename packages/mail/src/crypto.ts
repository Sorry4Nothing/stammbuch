import { MailError } from "./net-guard.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface KeyRingConfig {
  /** Schlüssel-ID -> Base64 von genau 32 Byte. */
  keys: Record<string, string>;
  /** ID des Schlüssels, mit dem neu verschlüsselt wird. */
  currentKeyId: string;
  /**
   * Für Altdaten ohne Schlüssel-ID im Format `v1.<iv>.<tag>.<ct>` (TOTP-Geheimnisse vor dem Schlüsselring):
   * ID des Ringschlüssels, mit dem sie verschlüsselt wurden. Sie gelten immer als rotationsbedürftig.
   */
  legacyKeyId?: string;
}

/**
 * AES-256-GCM für Zugangsdaten (SR-30, SR-31). Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>`
 * (Base64url). Mehrere Schlüssel sind gleichzeitig ladbar: neu wird mit dem aktuellen
 * verschlüsselt, alte Daten bleiben mit dem alten lesbar (Rotation). `aad` bindet den
 * Chiffretext an seinen Kontext (z.B. Konto-ID), so lässt er sich nicht in ein anderes Konto kopieren.
 * Klartext und Schlüssel erscheinen weder in Fehlertexten noch im Log.
 */
export class SecretBox {
  readonly #keys = new Map<string, Buffer>();
  readonly #currentKeyId: string;
  readonly #legacyKeyId: string | undefined;

  constructor(config: KeyRingConfig) {
    for (const [id, b64] of Object.entries(config.keys)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("Ungültige Schlüssel-ID");
      const key = Buffer.from(b64, "base64");
      if (key.length !== KEY_BYTES) throw new Error(`Schlüssel ${id} muss 32 Byte lang sein`);
      this.#keys.set(id, key);
    }
    if (!this.#keys.has(config.currentKeyId)) throw new Error("Aktueller Schlüssel fehlt");
    this.#currentKeyId = config.currentKeyId;
    if (config.legacyKeyId !== undefined && !this.#keys.has(config.legacyKeyId)) {
      throw new Error("Schlüssel für Altdaten fehlt");
    }
    this.#legacyKeyId = config.legacyKeyId;
  }

  /** ID des Schlüssels für neue Chiffretexte (keine Schlüsselbytes). */
  get currentKeyId(): string {
    return this.#currentKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    return this.encryptBytes(Buffer.from(plaintext, "utf8"), aad);
  }

  decrypt(token: string, aad: string): string {
    return this.decryptBytes(token, aad).toString("utf8");
  }

  /** Wie `encrypt` für beliebige Bytes (z.B. TOTP-Geheimnisse). */
  encryptBytes(plaintext: Buffer, aad: string): string {
    const key = this.#keys.get(this.#currentKeyId) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [VERSION, this.#currentKeyId, ...[iv, cipher.getAuthTag(), ct].map(b64u)].join(".");
  }

  decryptBytes(token: string, aad: string): Buffer {
    const parts = token.split(".");
    // Altformat ohne Schlüssel-ID: `v1.<iv>.<tag>.<ct>`.
    const legacy = parts.length === 4 && this.#legacyKeyId !== undefined;
    const [version, keyId, iv, tag, ct] = legacy
      ? [parts[0], this.#legacyKeyId, ...parts.slice(1)]
      : parts;
    const key = keyId ? this.#keys.get(keyId) : undefined;
    if (version !== VERSION || !key || !iv || !tag || ct === undefined) {
      throw new MailError("INTERNAL", "Entschlüsselung fehlgeschlagen");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]);
    } catch {
      // Bewusst generisch: kein Hinweis, ob Schlüssel, Kontext oder Daten falsch waren.
      throw new MailError("INTERNAL", "Entschlüsselung fehlgeschlagen");
    }
  }

  /** True, wenn der Chiffretext nicht mit dem aktuellen Schlüssel verschlüsselt ist (Altformat: immer). */
  needsRotation(token: string): boolean {
    const parts = token.split(".");
    return parts.length !== 5 || parts[1] !== this.#currentKeyId;
  }

  /** Verschlüsselt mit dem aktuellen Schlüssel neu (für den Rotationslauf). */
  rotate(token: string, aad: string): string {
    return this.encryptBytes(this.decryptBytes(token, aad), aad);
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

/** Liest einen Schlüsselring ("id:base64,id2:base64"), etwa `MAIL_ENCRYPTION_KEYS` mit `MAIL_ENCRYPTION_KEY_ID`. */
export function keyRingFromEnv(
  keys: string,
  currentKeyId: string,
  name = "MAIL_ENCRYPTION_KEYS",
): KeyRingConfig {
  const parsed: Record<string, string> = {};
  for (const part of keys.split(",")) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`${name}: erwartet id:base64,...`);
    parsed[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { keys: parsed, currentKeyId };
}

/**
 * Schlüsselring der TOTP-Geheimnisse aus der Umgebung. `AUTH_TOTP_KEY` (32 Byte, base64) bleibt Pflicht: er ist der
 * Hauptschlüssel für abgeleitete Schlüssel (Wiederherstellungscodes, Konto-Schlüssel) und entschlüsselt Altdaten
 * (Ring-ID `legacy`). Optional `AUTH_TOTP_KEYS` ("id:base64,...") und `AUTH_TOTP_KEY_ID` für die Rotation; ohne beide
 * ändert sich nichts ausser dem Format. Fehlerhafte Werte werfen (fail closed), ohne Schlüssel im Text.
 */
export function totpBoxFromEnv(env: NodeJS.ProcessEnv): SecretBox {
  const main = Buffer.from(env["AUTH_TOTP_KEY"] ?? "", "base64");
  if (main.length !== KEY_BYTES) throw new Error("AUTH_TOTP_KEY muss 32 Byte (base64) sein");
  const ring = env["AUTH_TOTP_KEYS"]
    ? keyRingFromEnv(env["AUTH_TOTP_KEYS"], "x", "AUTH_TOTP_KEYS")
    : { keys: {} as Record<string, string>, currentKeyId: "" };
  if ("legacy" in ring.keys) throw new Error("AUTH_TOTP_KEYS: die ID legacy ist reserviert");
  const ids = Object.keys(ring.keys);
  return new SecretBox({
    keys: { ...ring.keys, legacy: main.toString("base64") },
    currentKeyId: env["AUTH_TOTP_KEY_ID"] || ids[ids.length - 1] || "legacy",
    legacyKeyId: "legacy",
  });
}
