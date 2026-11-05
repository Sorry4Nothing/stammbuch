import type { RotationResult } from "@stammbuch/mail";

export interface RotationJobLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Schlüsselrotation der Postfach-Zugangsdaten über alle Mandanten (SR-30). Läuft höchstens alle `intervalMs`;
 * ohne Arbeit bleibt sie still. Nach einem Abbruch oder Fehler setzt der nächste Lauf beim Rest fort
 * (siehe `MailService.rotateSecrets`). Log und Protokoll enthalten nur Zähler und Konto-IDs, nie Schlüssel oder Klartext.
 */
export function createRotationJob(opts: {
  rotate: (signal: AbortSignal) => Promise<RotationResult>;
  /** Plattformprotokoll (Akteur `worker`). */
  audit: (now: Date, target: string) => Promise<void>;
  log: RotationJobLog;
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
    if (r.rotated + r.failed.length === 0) return;
    const counts = { rotated: r.rotated, failed: r.failed.length, aborted: r.aborted };
    if (r.failed.length > 0)
      opts.log.error({ ...counts, failedAccounts: r.failed }, "Schlüsselrotation");
    else opts.log.info(counts, "Schlüsselrotation");
    await opts.audit(
      t,
      `umgeschlüsselt ${r.rotated}, fehlgeschlagen ${r.failed.length}${r.aborted ? ", abgebrochen" : ""}`,
    );
  };
}
