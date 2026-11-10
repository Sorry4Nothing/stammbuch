import type { Organisation, Platform } from "../../platform/index.js";
import { DEFAULT_DUNNING } from "./dunning.js";
import { isQrIban, isSwissOrLiIban, normalizeIban } from "./iban.js";
import { MemorySettingsRepository } from "./memory.js";
import { QrBillError, buildQrPayload } from "./qrbill.js";
import { makeQrr } from "./reference.js";
import type { BillingSettings, SettingsRepository } from "./repository.js";

/**
 * Steuerpflicht aus der Organisation: nicht pflichtig heisst MwSt-Modus «ohne» und keine MwSt-Nummer. Ältere
 * Organisationen ohne das Feld gelten als pflichtig. Der Wechsel zurück zu «pflichtig» stellt den Standardmodus
 * «exklusiv» wieder her (er wurde beim Ausschalten auf «ohne» gesetzt); Belege, die schon bestehen, ändern sich nie.
 */
function vatPart(org: Organisation, existing: BillingSettings | null) {
  const vatLiable = org.master.vatLiable !== false;
  const wasExempt = existing?.vatLiable === false;
  const defaultVatMode: BillingSettings["defaultVatMode"] = !vatLiable
    ? "none"
    : wasExempt
      ? "exclusive"
      : (existing?.defaultVatMode ?? "exclusive");
  return { vatLiable, vatNumber: vatLiable ? org.master.vatNumber || null : null, defaultVatMode };
}

/**
 * Rechnungseinstellungen aus der Organisation ableiten: Rechnungssteller = Name und Adresse, IBAN = QR-IBAN
 * (sonst IBAN), Steuerpflicht samt MwSt-Nummer, Kontaktzeilen aus E-Mail und Telefon. Präfixe, Zahlungsfrist,
 * Mahnstufen, Standardkonto und Module bleiben, wie sie in `existing` stehen. `null`: Angaben noch unvollständig
 * oder kein gültiger QR-Zahlteil daraus ableitbar; dann bleibt alles unverändert.
 */
export function deriveBillingSettings(
  tenantId: string,
  org: Organisation,
  existing: BillingSettings | null,
): BillingSettings | null {
  const { master, bank } = org;
  const iban = normalizeIban(bank.qrIban || bank.iban);
  if (!master.name || !master.zip || !master.city || !isSwissOrLiIban(iban)) return null;
  if (master.country !== "CH" && master.country !== "LI") return null;
  const settings: BillingSettings = {
    tenantId,
    creditor: {
      name: master.name,
      ...(master.street ? { street: master.street } : {}),
      postalCode: master.zip,
      town: master.city,
      country: master.country,
    },
    iban,
    ...vatPart(org, existing),
    contactLines: [master.email, master.phone].filter(Boolean),
    numberPrefix: existing?.numberPrefix ?? "RE",
    creditNotePrefix: existing?.creditNotePrefix ?? "GS",
    referencePrefix: existing?.referencePrefix ?? "",
    paymentTermDays: existing?.paymentTermDays ?? 30,
    defaultVatRateBp: existing?.defaultVatRateBp ?? 810,
    roundTo5: existing?.roundTo5 ?? false,
    defaultRevenueAccount: existing?.defaultRevenueAccount ?? null,
    dunning: existing?.dunning ?? DEFAULT_DUNNING,
    features: existing?.features ?? { collectiveInvoicing: false },
  };
  // Gleicher Probelauf wie beim Speichern der Rechnungseinstellungen.
  try {
    buildQrPayload({
      iban,
      creditor: settings.creditor,
      amountCents: null,
      currency: "CHF",
      referenceType: isQrIban(iban) ? "QRR" : "NON",
      reference: isQrIban(iban) ? makeQrr("1") : undefined,
    });
  } catch (e) {
    if (e instanceof QrBillError) return null;
    throw e;
  }
  return settings;
}

/**
 * Legt die Rechnungseinstellungen an oder aktualisiert sie. Liefert `false`, wenn die Angaben noch nicht reichen;
 * bestehende Einstellungen übernehmen dann trotzdem die Steuerpflicht, damit der Server sie sofort erzwingt.
 */
export async function syncBillingSettings(
  repo: SettingsRepository,
  tenantId: string,
  org: Organisation,
): Promise<boolean> {
  const existing = await repo.get(tenantId);
  const next = deriveBillingSettings(tenantId, org, existing);
  if (!next) {
    if (existing) await repo.save({ ...existing, ...vatPart(org, existing) });
    return false;
  }
  await repo.save(next);
  return true;
}

// Ohne Datenbank (Entwicklung, Tests) teilen sich Rechnungen und Einstellungen die Speicher-Umsetzung je Plattform.
const memoryRepos = new WeakMap<Platform, MemorySettingsRepository>();
export function memorySettingsFor(platform: Platform): MemorySettingsRepository {
  let repo = memoryRepos.get(platform);
  if (!repo) memoryRepos.set(platform, (repo = new MemorySettingsRepository()));
  return repo;
}
