import { useSyncExternalStore } from "react";
import type { ImportResult } from "./types";

/**
 * Importe dieser Browser-Sitzung. Die API liefert Treffer und Restposten nur in der Antwort
 * des Imports und kennt keine Importliste: die Ansichten «Automatisch zugeordnet» und «Importe»
 * zeigen darum, was in dieser Sitzung importiert wurde.
 */
let history: readonly ImportResult[] = [];
const listeners = new Set<() => void>();

export function recordImport(result: ImportResult): void {
  history = [result, ...history];
  listeners.forEach((l) => l());
}

export function resetImports(): void {
  history = [];
  listeners.forEach((l) => l());
}

export function useImports(): readonly ImportResult[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => history,
  );
}
