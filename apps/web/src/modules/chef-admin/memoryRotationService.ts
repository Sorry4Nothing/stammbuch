import { CodeRejectedError } from "./model";
import {
  RotationLimitError,
  ROTATION_KINDS,
  type RotationKind,
  type RotationRun,
  type RotationService,
  type RotationStatus,
} from "./rotationModel";

export interface MemoryRotationOptions {
  /** Ergebnis je Art; Standard: nichts zu sichern (`rotated: 0`). Darf asynchron warten und werfen. */
  outcome?: (kind: RotationKind) => RotationRun[RotationKind] | Promise<RotationRun[RotationKind]>;
  /** Wird vor jeder Anfrage aufgerufen; wirft, um einen Serverfehler zu simulieren. */
  beforeRequest?: (name: "status" | "run") => void | Promise<void>;
  now?: () => Date;
}

/** Wie die API: höchstens 3 Läufe pro Minute, jeder Code nur einmal, "000000" ist nie gültig. */
const LIMIT = 3;

/** In-Memory-Datenquelle für Tests und Entwicklung. */
export function memoryRotationService(
  initial: RotationStatus,
  options: MemoryRotationOptions = {},
): RotationService & { runs: string[] } {
  const status = structuredClone(initial);
  const runs: string[] = [];
  const used = new Set<string>();
  const stamps: number[] = [];
  const now = options.now ?? (() => new Date());

  return {
    runs,

    async status() {
      await options.beforeRequest?.("status");
      return structuredClone(status);
    },

    async run(code) {
      await options.beforeRequest?.("run");
      const at = now().getTime();
      while (stamps.length > 0 && at - stamps[0]! >= 60_000) stamps.shift();
      if (stamps.length >= LIMIT) throw new RotationLimitError(60);
      stamps.push(at);
      if (!/^\d{6}$/.test(code) || code === "000000" || used.has(code)) {
        throw new CodeRejectedError();
      }
      used.add(code);
      runs.push(code);
      const result = {} as RotationRun;
      for (const kind of ROTATION_KINDS) {
        const state = status[kind];
        if (!state.configured) {
          result[kind] = null;
          continue;
        }
        const outcome = (await options.outcome?.(kind)) ?? {
          rotated: 0,
          failed: [],
          aborted: false,
        };
        result[kind] = outcome;
        if (!outcome.aborted) {
          state.lastRunAt = now().toISOString();
          state.unreadable = [...outcome.failed];
        }
      }
      return result;
    },
  };
}
