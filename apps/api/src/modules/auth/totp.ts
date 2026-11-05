import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Encode } from "./base32.js";

/** TOTP nach RFC 6238 (HMAC-SHA1, 30 s, 6 Stellen) auf Basis von HOTP (RFC 4226). */
export const TOTP_STEP_S = 30;
/** Toleranz: ein Schritt vor/zurück für Uhrabweichung, mehr nicht (ASVS, RFC 6238 §5.2). */
export const TOTP_WINDOW = 1;

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = h.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpCounter = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_S);

export function generateTotpSecret(): Buffer {
  return randomBytes(20); // 160 Bit, Empfehlung RFC 4226
}

/**
 * Prüft den Code gegen das Zeitfenster und liefert den passenden Zeitschritt (für den
 * Replay-Schutz) oder `null`. Alle Kandidaten werden verglichen, ohne frühen Abbruch.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const base = totpCounter(nowMs);
  let match: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const c = base + d;
    if (c < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, c)), given)) match = c;
  }
  return match;
}

export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_S),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
