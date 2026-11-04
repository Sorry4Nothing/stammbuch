import de from "./de.json";

/** Alle gültigen Text-Schlüssel. Ein unbekannter Schlüssel ist ein Typfehler. */
export type TextKey = keyof typeof de;

type Params = Record<string, string | number>;

/**
 * Übersetzt einen Schlüssel. Alle UI-Texte stehen in `de.json`, nie im Code.
 * Platzhalter: `t("key", { name: "Anna" })` ersetzt `{name}`.
 * Weitere Sprachen: Datei `<sprache>.json` mit denselben Schlüsseln ergänzen und hier wählen.
 */
export function t(key: TextKey, params?: Params): string {
  const text: string = de[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Wie `t`, wählt aber bei `n === 1` den Schlüssel `<key>.one`, falls vorhanden.
 * Der Platzhalter `{n}` wird automatisch mit `n` gefüllt.
 */
export function tp(key: TextKey, n: number, params?: Params): string {
  const one = `${key}.one`;
  const chosen = n === 1 && one in de ? (one as TextKey) : key;
  return t(chosen, { n, ...params });
}
