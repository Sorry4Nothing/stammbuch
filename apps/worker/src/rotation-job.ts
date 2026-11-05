import type { RotationResult } from "@stammbuch/mail";

export interface RotationJobLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Schlüsselrotation (SR-30) einer Art von Geheimnissen über alle Mandanten. Läuft höchstens alle `intervalMs`; ohne
 * Arbeit bleibt sie still. Nach einem Abbruch oder Fehler setzt der nächste Lauf beim Rest fort (siehe `rotateAll`).
 * Dauerhaft unlesbare Objekte werden nicht stündlich wiederholt: `record` hält die Menge fest und meldet nur bei
 * Änderung oder einmal täglich. Log und Protokoll enthalten nur Zähler und IDs, nie Schlüssel oder Klartext.
 */
export function createRotationJob(opts: {
  rotate: (signal: AbortSignal) => Promise<RotationResult>;
  /** Hält die unlesbaren IDs fest. True: Menge hat sich geändert oder ist einen Tag lang nicht gemeldet worden. */
  record: (now: Date, unreadable: string[]) => Promise<boolean>;
  /** Plattformprotokoll (Akteur `worker`). */
  audit: (now: Date, target: string) => Promise<void>;
  log: RotationJobLog;
  /** Name der Art im Log, z. B. `Schlüsselrotation Mail`. */
  label: string;
  intervalMs: number;
  now?: () => Date;
}) {
  const now = opts.now ?? (() => new Date());
  let lastRun: number | null = null;
  return async function tick(signal: AbortSignal) {
    const t = now();
    if (lastRun !== null && t.getTime() - lastRun < opts.intervalMs) return;
    lastRun = t.getTime();
    const r = await opts.rotate(signal);
    // Ein abgebrochener Lauf kennt die unlesbaren Objekte nur teilweise: Stand nicht anfassen.
    const changed = r.aborted ? false : await opts.record(t, r.failed);
    if (r.rotated === 0 && !changed) return;
    const counts = { rotated: r.rotated, failed: r.failed.length, aborted: r.aborted };
    if (changed && r.failed.length > 0)
      opts.log.error({ ...counts, failedIds: r.failed }, opts.label);
    else opts.log.info(counts, opts.label);
    await opts.audit(
      t,
      `umgeschlüsselt ${r.rotated}, fehlgeschlagen ${r.failed.length}${r.aborted ? ", abgebrochen" : ""}`,
    );
  };
}
