import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import type { Organisation } from "../../platform/index.js";
import type { InvoiceInput, SettingsInput } from "./schemas.js";
import { InvoiceService, type Repositories } from "./service.js";

/** Testdaten (erfunden, keine echten Personen): Beispiel-IBANs aus den SIX-Unterlagen. */
export const QR_IBAN = "CH44 3199 9123 0008 8901 2";
export const IBAN = "CH58 0079 1123 0008 8901 2";

export const settingsInput = (over: Partial<SettingsInput> = {}): SettingsInput => ({
  creditor: {
    name: "Musterverein Beispielstadt",
    street: "Vereinsweg",
    buildingNumber: "7",
    postalCode: "8000",
    town: "Zürich",
    country: "CH",
  },
  iban: QR_IBAN,
  vatNumber: null,
  contactLines: ["kasse@verein.example", "044 000 00 00"],
  numberPrefix: "RE",
  creditNotePrefix: "GS",
  referencePrefix: "",
  paymentTermDays: 30,
  defaultVatMode: "exclusive",
  defaultVatRateBp: 810,
  roundTo5: false,
  defaultRevenueAccount: null,
  ...over,
});

export const invoiceInput = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  debtor: {
    name: "Erika Beispiel",
    street: "Teststrasse",
    buildingNumber: "1",
    postalCode: "3000",
    town: "Bern",
    country: "CH",
  },
  currency: "CHF",
  issueDate: "2026-11-01",
  subject: "Mitgliederbeitrag 2026",
  notes: "Besten Dank für Ihre Zahlung.",
  lines: [
    { description: "Jahresbeitrag", quantityMilli: 1000, unitCents: 12000, vatRateBp: 0 },
    { description: "Beratung Stunden", quantityMilli: 1500, unitCents: 9000, vatRateBp: 810 },
  ],
  ...over,
});

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

export interface TestContext {
  service: InvoiceService;
  repos: Repositories;
  /** Die Uhr des Service: Tests stellen sie vor. */
  clock: { now: Date };
}

export function makeService(today = "2026-11-04T10:00:00Z"): TestContext {
  const clock = { now: new Date(today) };
  let n = 0;
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  const service = new InvoiceService({
    ...repos,
    now: () => clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { service, repos, clock };
}

/** QR-IBAN ohne Leerzeichen, wie sie die Organisation speichert. */
export const ORG_QR_IBAN = "CH4431999123000889012";

/** Organisation mit vollständiger Adresse und QR-IBAN. */
export function orgFixture(
  patch: Partial<Organisation["master"]> = {},
  qrIban = ORG_QR_IBAN,
): Organisation {
  return {
    master: {
      name: "Verein A",
      legalForm: "verein",
      street: "Weg 1",
      zip: "8000",
      city: "Zürich",
      country: "CH",
      uid: "",
      vatLiable: true,
      vatNumber: "",
      email: "",
      phone: "",
      website: "",
      ...patch,
    },
    sender: { name: "", email: "", replyTo: "", footer: "" },
    bank: { accountHolder: "", bankName: "", iban: "", creditAccount: "", qrIban, bic: "" },
    "fiscal-year": { startMonth: 1, closing: "monthly" },
    modules: { sammelrechnung: false, mail: true, kalender: true },
  };
}
