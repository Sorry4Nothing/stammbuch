import type { LoggerOptions } from "pino";
import { logRedactPaths } from "@stammbuch/shared";

/** pino-Optionen: strukturierte JSON-Logs, sensible Felder werden geschwärzt (SR-50). */
export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: [...logRedactPaths], censor: "[REDACTED]" },
  };
}
