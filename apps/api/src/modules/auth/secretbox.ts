import { createHmac, hkdfSync } from "node:crypto";
import type { SecretBox } from "@stammbuch/mail";

/**
 * TOTP-Geheimnisse im Ruhezustand: AES-256-GCM aus node:crypto (SR-03) über den Schlüsselring `SecretBox` des
 * Mail-Pakets, Format `v1.<keyId>.<iv>.<tag>.<ct>`. Neu wird mit dem aktuellen Schlüssel verschlüsselt, alte Daten
 * bleiben mit dem alten lesbar (Rotation, SR-30); das Altformat `v1.<iv>.<tag>.<ct>` ohne Schlüssel-ID bleibt lesbar.
 * Das Geheimnis muss rückholbar sein (TOTP braucht es im Klartext), daher kein Hash.
 * Die Nutzer-ID ist als AAD gebunden: ein kopierter Geheimtext in eine andere Zeile wird abgelehnt.
 */
export const encryptSecret = (box: SecretBox, aad: string, plain: Buffer): string =>
  box.encryptBytes(plain, aad);

export const decryptSecret = (box: SecretBox, aad: string, enc: string): Buffer =>
  box.decryptBytes(enc, aad);

/** Schlüssel für HMACs (Wiederherstellungscodes, Konto-Schlüssel), abgeleitet aus dem Hauptschlüssel. */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), purpose, 32));
}

export const hmacHex = (key: Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest("hex");
