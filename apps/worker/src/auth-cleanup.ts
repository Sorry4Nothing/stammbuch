export interface AuthCleanupDb {
  raeumeAuthAuf(jetzt: Date): Promise<{ sitzungen: number; sperren: number; ereignisse: number }>;
}

/**
 * Wartungsjob: abgelaufene und widerrufene Sitzungen, verfallene Sperrzähler und alte Ereignisse ohne
 * Mandant löschen (kundenübergreifend, per SECURITY-DEFINER-Funktion `auth_aufraeumen`). Die Worker-Schleife
 * tickt oft; der Job läuft nur, wenn `intervalMs` seit dem letzten Lauf vergangen ist. Ein Fehler wird
 * weitergereicht (die Schleife meldet ihn) und der nächste Tick versucht es erneut.
 */
export function createAuthCleanupJob(opts: {
  db: AuthCleanupDb;
  intervalMs: number;
  onResult: (r: { sitzungen: number; sperren: number; ereignisse: number }) => void;
  now?: () => Date;
}) {
  const now = opts.now ?? (() => new Date());
  let lastRun: number | null = null;
  return async function tick() {
    const t = now();
    if (lastRun !== null && t.getTime() - lastRun < opts.intervalMs) return;
    const result = await opts.db.raeumeAuthAuf(t);
    lastRun = t.getTime();
    opts.onResult(result);
  };
}
