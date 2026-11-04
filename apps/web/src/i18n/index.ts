import de from "./de.json";

/** Alle gültigen Text-Schlüssel. Ein unbekannter Schlüssel ist ein Typfehler. */
export type TextKey = keyof typeof de;

/**
 * Übersetzt einen Schlüssel. Alle UI-Texte stehen in `de.json`, nie im Code.
 * Platzhalter: `t("key", { name: "Anna" })` ersetzt `{name}`.
 * Weitere Sprachen: Datei `<sprache>.json` mit denselben Schlüsseln ergänzen und hier wählen.
 */
export function t(key: TextKey, params?: Record<string, string | number>): string {
  const text: string = de[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
