import { z } from "zod";
import { MailError } from "./net-guard.js";
import { headerSafe } from "./template.js";

// Strenger als RFC 5322: keine Anführungszeichen, Kommentare, Gruppen, Steuerzeichen, Leerzeichen.
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const emailSchema = z
  .string()
  .max(254)
  .regex(ADDRESS)
  .transform((v) => v.toLowerCase());

/** Prüft eine einzelne Mailadresse (Header-Injection-Schutz, SR-20). Wirft VALIDATION. */
export function assertEmail(value: string): string {
  const r = emailSchema.safeParse(value);
  if (!r.success) throw new MailError("VALIDATION");
  return r.data;
}

/** Anzeigename für Header: ohne Steuerzeichen, Anführungszeichen und spitze Klammern. */
export function displayName(value: string | undefined): string | undefined {
  const clean = headerSafe(value ?? "", 120).replace(/["<>\\]/g, "");
  return clean === "" ? undefined : clean;
}
