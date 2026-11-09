/**
 * Kurze Gerätebezeichnung aus dem User-Agent («Firefox auf Windows»). Es kommen nur Namen aus diesen festen Listen
 * heraus: der rohe User-Agent wird weder gespeichert noch protokolliert (Datensparsamkeit). Nicht erkennbar: `null`.
 */

// Reihenfolge zählt: Edge, Opera und Samsung Internet nennen sich auch «Chrome», Chrome nennt sich «Safari».
const BROWSERS: [RegExp, string][] = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

// iOS vor macOS («like Mac OS X»), Android vor Linux.
const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

export function deviceLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  // Begrenzen, bevor die Muster laufen (Header sind schon vom Server begrenzt, das hier ist die zweite Schranke).
  const ua = userAgent.slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} auf ${system}`;
  return browser ?? system ?? null;
}
