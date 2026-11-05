import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isValidReference, normalizeReference } from "./reference.js";
import { CamtError } from "./types.js";
import { hasDtd } from "./upload.js";
import type { CamtDocument, CamtKind, CamtTransaction, Direction, ReferenceKind } from "./types.js";

const MAX_TRANSACTIONS = 20_000;
const MAX_REMITTANCE_LENGTH = 500;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
/** Elemente, die laut Schema mehrfach vorkommen dürfen; immer als Array lesen. */
const ARRAY_TAGS = new Set(["Stmt", "Ntfctn", "Ntry", "NtryDtls", "TxDtls", "Strd", "Ustrd"]);

// Sichere Konfiguration (SR-25): DOCTYPE/ENTITY lehnt `checkUpload` vorab ab, hier gelten nur
// die vordefinierten XML-Entitäten; die Verschachtelung ist begrenzt. Die Bibliothek lädt
// keine Dateien oder URLs.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  maxNestedTags: 40,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const kid = (n: unknown, key: string): unknown => (isNode(n) ? n[key] : undefined);
const path = (n: unknown, ...keys: string[]): unknown => keys.reduce<unknown>(kid, n);

/** Text eines Elements, mit oder ohne Attribute. */
function text(v: unknown): string | undefined {
  if (typeof v === "string") return v === "" ? undefined : v;
  if (isNode(v) && typeof v["#text"] === "string") return v["#text"] || undefined;
  return undefined;
}

function fail(msg: string): never {
  throw new CamtError("INVALID_CONTENT", msg);
}

function parseDate(v: unknown, what: string): string {
  const iso = (text(path(v, "Dt")) ?? text(path(v, "DtTm")))?.slice(0, 10);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return fail(`${what}: ungültiges Datum.`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    return fail(`${what}: ungültiges Datum.`);
  }
  return iso;
}

/** "1234.50" -> 123450. Nur positive Beträge mit höchstens zwei Nachkommastellen. */
export function parseAmountRappen(raw: string | undefined): number {
  const m = raw === undefined ? null : /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return fail("Ungültiger Betrag.");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function parseAmount(amt: unknown): { amountRappen: number; currency: string } {
  const currency = isNode(amt) ? amt["@_Ccy"] : undefined;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    return fail("Ungültige Währung.");
  }
  return { amountRappen: parseAmountRappen(text(amt)), currency };
}

function parseDirection(v: unknown): Direction {
  const s = text(v);
  if (s === "CRDT") return "CREDIT";
  if (s === "DBIT") return "DEBIT";
  return fail("Ungültige Soll/Haben-Kennzeichnung.");
}

function parseReference(txDtls: unknown): CamtTransaction["reference"] {
  for (const strd of asArray(path(txDtls, "RmtInf", "Strd"))) {
    const raw = text(path(strd, "CdtrRefInf", "Ref"));
    if (!raw) continue;
    const value = normalizeReference(raw);
    const code = path(strd, "CdtrRefInf", "Tp", "CdOrPrtry");
    const typeText = text(kid(code, "Prtry")) ?? text(kid(code, "Cd"));
    let kind: ReferenceKind | undefined;
    if (typeText === "QRR" || typeText === "SCOR") kind = typeText;
    else if (!typeText) {
      kind = /^\d{27}$/.test(value) ? "QRR" : value.startsWith("RF") ? "SCOR" : undefined;
    }
    if (kind) return { kind, value, valid: isValidReference(kind, value) };
  }
  return undefined;
}

function parseRemittance(txDtls: unknown): string | undefined {
  const parts = [
    ...asArray(path(txDtls, "RmtInf", "Ustrd")).map(text),
    ...asArray(path(txDtls, "RmtInf", "Strd")).map((s) => text(kid(s, "AddtlRmtInf"))),
    text(kid(txDtls, "AddtlTxInf")),
  ].filter((s): s is string => !!s);
  // Steuerzeichen entfernen: der Text geht später in Oberflächen und Exporte.
  const joined = [...parts.join(" ")]
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? " " : c))
    .join("")
    .trim();
  return joined ? joined.slice(0, MAX_REMITTANCE_LENGTH) : undefined;
}

/** Debitor (Zahler) bei Gutschriften; Version 04 `Dbtr/Nm`, Version 08 `Dbtr/Pty/Nm`. */
function parseDebtor(txDtls: unknown): { debtorName?: string; debtorIban?: string } {
  const party = path(txDtls, "RltdPties", "Dbtr");
  const ultimate = path(txDtls, "RltdPties", "UltmtDbtr");
  const debtorName =
    text(path(party, "Nm")) ??
    text(path(party, "Pty", "Nm")) ??
    text(path(ultimate, "Nm")) ??
    text(path(ultimate, "Pty", "Nm"));
  const iban = text(path(txDtls, "RltdPties", "DbtrAcct", "Id", "IBAN"));
  return { debtorName, debtorIban: iban && IBAN.test(iban) ? iban : undefined };
}

function isBooked(ntry: unknown): boolean {
  const sts = kid(ntry, "Sts");
  const code = text(sts) ?? text(kid(sts, "Cd")) ?? text(kid(sts, "Prtry"));
  return code === undefined || code === "BOOK";
}

function parseEntry(ntry: unknown, accountIban: string, out: CamtTransaction[]): void {
  const ntryAmount = parseAmount(kid(ntry, "Amt"));
  const ntryDirection = parseDirection(kid(ntry, "CdtDbtInd"));
  const reversalText = text(kid(ntry, "RvslInd"));
  if (reversalText !== undefined && reversalText !== "true" && reversalText !== "false") {
    fail("Ungültiger Storno-Indikator.");
  }
  const valDt = kid(ntry, "ValDt");
  const common = {
    accountIban,
    bookingDate: parseDate(kid(ntry, "BookgDt"), "Buchungsdatum"),
    valueDate: valDt === undefined ? undefined : parseDate(valDt, "Valuta"),
    reversal: reversalText === "true",
  };
  const entryBankRef = text(kid(ntry, "AcctSvcrRef")) ?? text(kid(ntry, "NtryRef"));

  const details = asArray(kid(ntry, "NtryDtls")).flatMap((d) => asArray(kid(d, "TxDtls")));
  if (details.length === 0) {
    out.push({
      ...common,
      ...ntryAmount,
      direction: ntryDirection,
      bankReference: entryBankRef,
      ordinal: out.length,
    });
    return;
  }
  for (const tx of details) {
    // Bei Sammelbuchungen steht der Einzelbetrag in TxDtls/Amt; bei genau einer Einzelbuchung
    // darf er fehlen, dann gilt der Betrag des Eintrags.
    const amount =
      kid(tx, "Amt") !== undefined
        ? parseAmount(kid(tx, "Amt"))
        : details.length === 1
          ? ntryAmount
          : fail("Einzelbetrag fehlt.");
    const direction =
      kid(tx, "CdtDbtInd") !== undefined ? parseDirection(kid(tx, "CdtDbtInd")) : ntryDirection;
    const e2e = text(path(tx, "Refs", "EndToEndId"));
    out.push({
      ...common,
      ...amount,
      direction,
      bankReference: text(path(tx, "Refs", "AcctSvcrRef")) ?? entryBankRef,
      endToEndId: e2e && e2e !== "NOTPROVIDED" ? e2e : undefined,
      reference: parseReference(tx),
      ...(direction === "CREDIT" ? parseDebtor(tx) : {}),
      remittanceInfo: parseRemittance(tx),
      ordinal: out.length,
    });
  }
}

/** Namespace des Wurzelelements (die Bibliothek entfernt xmlns-Attribute beim Lesen). */
function rootNamespace(xml: string) {
  const start = /<(?:[\w.-]+:)?Document[\s>]/.exec(xml);
  if (!start) return null;
  const tag = xml.slice(start.index, xml.indexOf(">", start.index));
  return /\sxmlns(?::[\w.-]+)?\s*=\s*["']urn:iso:std:iso:20022:tech:xsd:camt\.(053|054)\.001\.(\d{2})["']/.exec(
    tag,
  );
}

/**
 * Liest CAMT.053 (Kontoauszug) oder CAMT.054 (Zahlungsavis) im ISO-20022-Schema, auch in der
 * Ausprägung der Schweizer Implementation Guidelines. Wirft `CamtError` bei jedem Mangel
 * (fail secure, SR-54); die Meldungen enthalten keine Dateiinhalte (SR-51).
 */
export function parseCamt(xml: string): CamtDocument {
  try {
    return parseDocument(xml);
  } catch (e) {
    // Jeder unerwartete Fehler an dieser Grenze heisst: Datei ablehnen (fail secure).
    if (e instanceof CamtError) throw e;
    throw new CamtError("INVALID_CONTENT", "Datei nicht lesbar.");
  }
}

function parseDocument(xml: string): CamtDocument {
  if (hasDtd(xml)) throw new CamtError("INVALID_XML", "DTD und Entitäten sind nicht erlaubt.");
  if (XMLValidator.validate(xml) !== true) {
    throw new CamtError("INVALID_XML", "XML nicht wohlgeformt.");
  }
  let root: unknown;
  try {
    root = parser.parse(xml);
  } catch {
    throw new CamtError("INVALID_XML", "XML nicht lesbar.");
  }
  const doc = kid(root, "Document");
  const m = rootNamespace(xml);
  if (!m) throw new CamtError("UNSUPPORTED_FORMAT", "Kein CAMT.053/CAMT.054.");
  const kind: CamtKind = m[1] === "053" ? "camt.053" : "camt.054";
  const version = m[2] ?? "";
  if (Number(version) < 2 || Number(version) > 12) {
    throw new CamtError("UNSUPPORTED_FORMAT", "CAMT-Version nicht unterstützt.");
  }

  const body = kid(doc, kind === "camt.053" ? "BkToCstmrStmt" : "BkToCstmrDbtCdtNtfctn");
  if (!body) throw new CamtError("UNSUPPORTED_FORMAT", "Nachrichtentyp passt nicht zum Schema.");
  const messageId = text(path(body, "GrpHdr", "MsgId")) ?? fail("MsgId fehlt.");

  const transactions: CamtTransaction[] = [];
  let ignoredEntries = 0;
  for (const stmt of asArray(kid(body, kind === "camt.053" ? "Stmt" : "Ntfctn"))) {
    const iban = text(path(stmt, "Acct", "Id", "IBAN"));
    if (!iban || !IBAN.test(iban)) fail("Konto-IBAN fehlt oder ungültig.");
    for (const ntry of asArray(kid(stmt, "Ntry"))) {
      if (!isBooked(ntry)) {
        ignoredEntries++;
        continue;
      }
      parseEntry(ntry, iban as string, transactions);
      if (transactions.length > MAX_TRANSACTIONS) fail("Zu viele Buchungen.");
    }
  }
  return {
    kind,
    version,
    messageId,
    createdAt: text(path(body, "GrpHdr", "CreDtTm")),
    transactions,
    ignoredEntries,
  };
}
