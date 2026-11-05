/** Obergrenzen für das Kundenlogo (SR-23). */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_PX = 16;
export const LOGO_MAX_PX = 2000;
export const LOGO_MIMES = ["image/png", "image/jpeg"] as const;
export type LogoMime = (typeof LOGO_MIMES)[number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

type Detected = { mime: LogoMime; width: number; height: number };

function inspectPng(b: Buffer): Detected | undefined {
  // Aufbau: Signatur, dann der IHDR-Block (Länge 13, Typ IHDR, Breite, Höhe) und am Ende IEND.
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return undefined;
  if (!b.subarray(-12).equals(PNG_IEND)) return undefined;
  return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function inspectJpeg(b: Buffer): Detected | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return undefined;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return undefined;
  // Segmente durchlaufen, bis ein Start-of-Frame-Block (SOF0 bis SOF15 ohne DHT, JPG, DAC) die Grösse nennt.
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (i + 9 > b.length) return undefined;
      return { mime: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

/**
 * Prüft die Datei am Inhalt, nicht am Namen oder Header (SR-23): Magic Bytes, Struktur und
 * Bildgrösse. SVG und alles andere wird abgelehnt. Gibt `undefined` zurück, wenn etwas nicht stimmt.
 */
export function inspectLogo(bytes: Buffer, declaredMime: string): Detected | undefined {
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return undefined;
  const found = inspectPng(bytes) ?? inspectJpeg(bytes);
  if (!found || found.mime !== declaredMime) return undefined;
  const ok = (n: number) => n >= LOGO_MIN_PX && n <= LOGO_MAX_PX;
  return ok(found.width) && ok(found.height) ? found : undefined;
}
