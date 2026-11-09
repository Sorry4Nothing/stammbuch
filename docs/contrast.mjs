// WCAG-Kontrastprüfung für tokens.css. Aufruf: node docs/contrast.mjs
// Keine Abhängigkeiten. Exit 1, wenn Normaltext < 4.5 oder UI/grosser Text < 3.0.
// Art "info": wird gemessen und ausgegeben, beeinflusst den Exit-Code nicht.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../apps/web/src/styles/tokens.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

// Theme-Blöcke einlesen (Selektor enthält data-theme="light" bzw. "dark").
const themes = { light: {}, dark: {} };
for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  for (const name of Object.keys(themes)) {
    if (!sel.includes(`[data-theme="${name}"]`)) continue;
    for (const [, k, v] of body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g))
      themes[name][k] = v;
  }
}

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const MIN = { text: 4.5, ui: 3.0, info: null };
// [Art, Vordergrund, Hintergrund, Beschreibung]
const pairs = [
  ["text", "text", "bg", "Haupttext auf Seitengrund"],
  ["text", "text", "surface", "Haupttext auf Fläche"],
  ["text", "text", "surface-2", "Haupttext auf Tabellenkopf/Auswahl"],
  ["text", "text-muted", "bg", "Hilfstext auf Seitengrund"],
  ["text", "text-muted", "surface", "Hilfstext auf Fläche"],
  ["text", "text-muted", "surface-2", "Hilfstext auf Tabellenkopf"],
  ["text", "on-primary", "primary", "Primär-Button-Text"],
  ["text", "on-accent", "accent", "Text auf Akzentfläche"],
  ["text", "primary", "surface", "Primär als Text/Link auf Fläche"],
  ["text", "primary", "bg", "Primär als Text/Link auf Seitengrund"],
  ["text", "success-text", "success-bg", "Erfolg-Meldung/Badge"],
  ["text", "warning-text", "warning-bg", "Warn-Meldung/Badge"],
  ["text", "error-text", "error-bg", "Fehler-Meldung/Badge"],
  ["text", "error-text", "surface", "Fehlertext unter Feld"],
  ["text", "paper-text", "paper", "Text auf Papier"],
  ["text", "paper-muted", "paper", "Nebentext auf Papier"],
  ["ui", "focus", "surface", "Fokusring auf Fläche"],
  ["ui", "focus", "bg", "Fokusring auf Seitengrund"],
  ["ui", "border-strong", "surface", "Feld-/Schaltflächenrand auf Fläche"],
  ["ui", "border-strong", "bg", "Feld-/Schaltflächenrand auf Seitengrund"],
  ["ui", "success", "surface", "Erfolg: Symbol/Linie auf Fläche"],
  [
    "info",
    "warning",
    "surface",
    "Warnung: Symbol/Linie auf Fläche (Design-Wert, Text steht daneben)",
  ],
  ["ui", "error", "surface", "Fehler: Symbol/Linie/Feldrand auf Fläche"],
  ["info", "accent", "surface", "Akzent: Markierung auf Fläche (Design-Wert, Punkt hat Rand)"],
  ["ui", "success", "success-bg", "Erfolg: Rand auf Meldungsgrund"],
  [
    "info",
    "warning",
    "warning-bg",
    "Warnung: Rand auf Meldungsgrund (Design-Wert, Text steht daneben)",
  ],
  ["ui", "error", "error-bg", "Fehler: Rand auf Meldungsgrund"],
  ["info", "success", "surface", "Erfolg als Text auf Fläche (nicht vorgesehen)"],
  ["info", "warning", "surface", "Warnung als Text auf Fläche (nicht vorgesehen)"],
  ["info", "error", "surface", "Fehler als Text auf Fläche (nicht vorgesehen)"],
  ["info", "accent", "surface", "Akzent als Text auf Fläche (nicht vorgesehen)"],
];

let fails = 0;
const rows = [];
for (const theme of Object.keys(themes)) {
  for (const [kind, fg, bg, desc] of pairs) {
    const f = themes[theme][fg],
      b = themes[theme][bg];
    if (!f || !b) {
      console.error(`Token fehlt: ${theme} ${fg}/${bg}`);
      process.exit(2);
    }
    const r = ratio(f, b);
    const min = MIN[kind];
    const ok = min === null ? null : r >= min;
    if (ok === false) fails++;
    rows.push({ theme, kind, fg, bg, f, b, r, min, ok, desc });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${pad("Theme", 6)} ${pad("Art", 5)} ${pad("Paar", 38)} ${pad("Farben", 17)} ${pad("Kontrast", 9)} ${pad("Min", 4)} Ergebnis`,
);
for (const x of rows) {
  const res = x.ok === null ? "info" : x.ok ? "OK" : "DURCHGEFALLEN";
  console.log(
    `${pad(x.theme, 6)} ${pad(x.kind, 5)} ${pad(`${x.fg} auf ${x.bg}`, 38)} ${pad(`${x.f}/${x.b}`, 17)} ${pad(x.r.toFixed(2) + ":1", 9)} ${pad(x.min ?? "-", 4)} ${res}`,
  );
}
const checked = rows.filter((x) => x.ok !== null).length;
console.log(`\n${checked - fails} von ${checked} Prüfungen bestanden, ${fails} durchgefallen.`);
process.exit(fails ? 1 : 0);
