import type { StartData, StartService } from "./startService";

/** In-Memory-Datenquelle für Tests und Entwicklung. `fail` simuliert einen Serverfehler. */
export function memoryStartService(
  data: StartData,
  options: { fail?: () => boolean } = {},
): StartService {
  return {
    load: async () => {
      if (options.fail?.()) throw new Error("Zeitüberschreitung (504)");
      return structuredClone(data);
    },
  };
}
