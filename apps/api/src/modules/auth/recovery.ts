import { randomInt } from "node:crypto";
import { hmacHex } from "./secretbox.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne 0/O/1/I (Abtippen)
export const RECOVERY_CODE_COUNT = 10;

/** 16 Zeichen = 80 Bit Entropie, angezeigt als XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]);
    return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
  });
}

/** Eingabe tolerant normalisieren: Gross-/Kleinschreibung, Bindestriche und Leerzeichen egal. */
export const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

/**
 * Gespeichert wird nur der HMAC (mit Serverschlüssel). Einmalverwendung erzwingt das Repository
 * über `consumeRecoveryCode` (atomar).
 */
export const hashRecoveryCode = (key: Buffer, code: string) =>
  hmacHex(key, normalizeRecoveryCode(code));
