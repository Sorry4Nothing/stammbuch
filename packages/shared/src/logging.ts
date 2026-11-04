/**
 * Pfade, die in Logs immer unkenntlich gemacht werden (SR-50).
 * Gilt für API und Worker; neue sensible Felder hier ergänzen.
 */
export const logRedactPaths: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "password",
  "passwort",
  "token",
  "*.password",
  "*.passwort",
  "*.token",
];
