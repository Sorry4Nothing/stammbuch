import { CamtError } from "./types.js";

/** Obergrenze für eine CAMT-Datei (SR-23). Reale Monatsauszüge kleiner Vereine liegen weit darunter. */
export const MAX_CAMT_BYTES = 5 * 1024 * 1024;

const FORBIDDEN_DECLARATIONS = /<!\s*(DOCTYPE|ENTITY)/i;

/** DTD oder Entitätsdeklaration vorhanden? (XXE, Billion Laughs, SR-25) */
export const hasDtd = (xml: string): boolean => FORBIDDEN_DECLARATIONS.test(xml);

/**
 * Serverseitige Prüfung einer hochgeladenen Datei (SR-23). Dateiname und Content-Type des
 * Clients werden nicht beachtet; entscheidend ist der Inhalt: gültiges UTF-8, Textdokument,
 * das mit einer XML-Deklaration oder dem Wurzelelement beginnt, ohne DTD/Entitäten (SR-25).
 * Gibt den dekodierten Text zurück.
 */
export function checkUpload(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new CamtError("INVALID_UPLOAD", "Leere Datei.");
  if (bytes.byteLength > MAX_CAMT_BYTES) throw new CamtError("FILE_TOO_LARGE", "Datei zu gross.");
  // UTF-16-BOMs: nicht unterstützt (die Nullbytes würden sonst als "Binärdaten" auffallen).
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new CamtError("INVALID_UPLOAD", "Nur UTF-8 wird unterstützt.");
  }
  if (bytes.includes(0)) throw new CamtError("INVALID_UPLOAD", "Keine Textdatei.");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CamtError("INVALID_UPLOAD", "Ungültige Zeichenkodierung.");
  }

  const head = text.trimStart();
  if (!head.startsWith("<?xml") && !head.startsWith("<Document")) {
    throw new CamtError("INVALID_UPLOAD", "Keine XML-Datei.");
  }
  const declared = /^<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  if (declared && declared.toLowerCase() !== "utf-8") {
    throw new CamtError("INVALID_UPLOAD", "Nur UTF-8 wird unterstützt.");
  }
  if (hasDtd(text)) {
    throw new CamtError("INVALID_XML", "DTD und Entitäten sind nicht erlaubt.");
  }
  return text;
}
