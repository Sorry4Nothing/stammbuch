import { createHash } from "node:crypto";
import { MailError } from "./net-guard.js";

/** Erlaubte Endungen mit fest zugeordnetem Content-Type und Magic-Bytes (Client-Angaben zählen nicht, SR-23). */
const ALLOWED: Record<string, { type: string; magic?: string }> = {
  pdf: { type: "application/pdf", magic: "%PDF-" },
  png: { type: "image/png", magic: "\x89PNG" },
  jpg: { type: "image/jpeg", magic: "\xff\xd8\xff" },
  jpeg: { type: "image/jpeg", magic: "\xff\xd8\xff" },
  gif: { type: "image/gif", magic: "GIF8" },
  txt: { type: "text/plain" },
  csv: { type: "text/csv" },
  ics: { type: "text/calendar" },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: "PK" },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: "PK" },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: "PK" },
  odt: { type: "application/vnd.oasis.opendocument.text", magic: "PK" },
  ods: { type: "application/vnd.oasis.opendocument.spreadsheet", magic: "PK" },
}; // prettier-ignore

export interface CheckedAttachment {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

/** Bereinigter Anzeigename: nur Basisname, keine Pfad- und Steuerzeichen. Ablage erfolgt unter generierter ID. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return (
    base
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120)
  );
}

export function checkAttachment(
  filename: string,
  bytes: Buffer,
  maxBytes: number,
): CheckedAttachment {
  const name = safeFilename(filename);
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
  const rule = ext ? ALLOWED[ext] : undefined;
  if (!name || !rule) throw new MailError("VALIDATION");
  if (bytes.length === 0 || bytes.length > maxBytes) throw new MailError("TOO_LARGE");
  if (rule.magic && bytes.subarray(0, rule.magic.length).toString("latin1") !== rule.magic) {
    throw new MailError("VALIDATION");
  }
  return {
    filename: name,
    contentType: rule.type,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}
