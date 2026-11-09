import { useTabs } from "../../shell/tabs";
import { MODULE_IDS } from "../types";
import type { PersonDetail } from "./model";

/** Eintrag einer neuen Adressliste (Form wie `ListEntry` im Modul Mail). */
function listEntry(p: PersonDetail) {
  return {
    key: p.id,
    personId: p.id,
    name: p.name,
    email: p.email,
    group: p.gruppeName,
    ...(p.anrede && p.anrede !== "divers" ? { anrede: p.anrede === "frau" ? "Frau" : "Herr" } : {}),
    vorname: p.vorname,
    nachname: p.nachname,
  };
}

/**
 * Öffnet Tabs anderer Module für eine Person. Eine Funktion ist `undefined`, wenn das Modul oder
 * sein Tab-Typ fehlt: die Schaltfläche erscheint dann nicht.
 */
export function useModuleLinks() {
  const { modules, openTab } = useTabs();
  const has = (moduleId: string, type: string) =>
    modules.some((m) => m.id === moduleId && m.tabTypes.some((x) => x.id === type));
  const mail = has("mail", "mail-compose");
  const lists = has("mail", "mail-list");
  const invoices = has(MODULE_IDS.invoices, "rechnung-neu");
  const accounting = has(MODULE_IDS.accounting, "accounting-debitor");

  return {
    /** Neue Mail an die Person (leerer Empfänger, wenn sie keine Adresse hat). */
    writeMail: mail
      ? (p: Pick<PersonDetail, "email">) =>
          openTab("mail-compose", { params: p.email ? { to: p.email } : {} })
      : undefined,
    /** Neue Adressliste mit diesen Personen. */
    addToList: lists
      ? (people: readonly PersonDetail[]) =>
          openTab("mail-list", { params: { entries: JSON.stringify(people.map(listEntry)) } })
      : undefined,
    createInvoice: invoices
      ? (p: Pick<PersonDetail, "id" | "name">) =>
          openTab("rechnung-neu", { params: { personId: p.id, name: p.name } })
      : undefined,
    openDebtorAccount: accounting
      ? (p: Pick<PersonDetail, "id" | "name">) =>
          openTab("accounting-debitor", {
            key: p.id,
            params: { personId: p.id, name: p.name },
            title: p.name,
          })
      : undefined,
  };
}
