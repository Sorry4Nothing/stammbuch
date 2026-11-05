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

  constructor(config: KeyRingConfig) {
    for (const [id, b64] of Object.entries(config.keys)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("Ungültige Schlüssel-ID");
      const key = Buffer.from(b64, "base64");
      if (key.length !== KEY_BYTES) throw new Error(`Schlüssel ${id} muss 32 Byte lang sein`);
      this.#keys.set(id, key);
    }
    if (!this.#keys.has(config.currentKeyId)) throw new Error("Aktueller Schlüssel fehlt");
    this.#currentKeyId = config.currentKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.#keys.get(this.#currentKeyId) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, this.#currentKeyId, ...[iv, cipher.getAuthTag(), ct].map(b64u)].join(".");
  }

  decrypt(token: string, aad: string): string {
    const [version, keyId, iv, tag, ct] = token.split(".");
    const key = keyId ? this.#keys.get(keyId) : undefined;
    if (version !== VERSION || !key || !iv || !tag || ct === undefined) {
      throw new MailError("INTERNAL", "Entschlüsselung fehlgeschlagen");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Bewusst generisch: kein Hinweis, ob Schlüssel, Kontext oder Daten falsch waren.
      throw new MailError("INTERNAL", "Entschlüsselung fehlgeschlagen");
    }
  }

  /** True, wenn der Chiffretext nicht mit dem aktuellen Schlüssel verschlüsselt ist. */
  needsRotation(token: string): boolean {
    return token.split(".")[1] !== this.#currentKeyId;
  }

  /** Verschlüsselt mit dem aktuellen Schlüssel neu (für den Rotationslauf). */
  rotate(token: string, aad: string): string {
    return this.encrypt(this.decrypt(token, aad), aad);
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

/** Liest `MAIL_ENCRYPTION_KEYS` ("id:base64,id2:base64") und `MAIL_ENCRYPTION_KEY_ID`. */
export function keyRingFromEnv(keys: string, currentKeyId: string): KeyRingConfig {
  const parsed: Record<string, string> = {};
  for (const part of keys.split(",")) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error("MAIL_ENCRYPTION_KEYS: erwartet id:base64,...");
    parsed[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { keys: parsed, currentKeyId };
}
