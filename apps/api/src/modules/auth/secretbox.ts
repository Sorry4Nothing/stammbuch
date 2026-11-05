import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Verschlüsselt TOTP-Geheimnisse im Ruhezustand (AES-256-GCM aus node:crypto, SR-03).
 * Das Geheimnis muss rückholbar sein (TOTP braucht es im Klartext), daher kein Hash.
 * Die Nutzer-ID ist als AAD gebunden: ein kopierter Geheimtext in eine andere Zeile wird abgelehnt.
 * shortcut: ein einziger Schlüssel (Präfix `v1`), Rotation später per `v2`-Präfix + Neuverschlüsselung.
 */
export function encryptSecret(key: Buffer, aad: string, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(key: Buffer, aad: string, enc: string): Buffer {
  const [v, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unbekanntes Format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
}

/** Schlüssel für HMACs (Wiederherstellungscodes, Konto-Schlüssel), abgeleitet aus dem Hauptschlüssel. */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), purpose, 32));
}

export const hmacHex = (key: Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest("hex");
