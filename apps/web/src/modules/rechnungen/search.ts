import { t } from "../../i18n";
import type { SearchHit, SearchProvider } from "../types";
import { displayStatus, type Invoice } from "./model";
import { invoiceName, statusLabel, statusTone } from "./parts";

const LIMIT = 8;

/** Rechnungssuche (Strg+K): Nummer, Empfänger und Betreff über `GET /invoices?q=`. Nur lesend, Mandant serverseitig. */
export const rechnungenSearch: SearchProvider = {
  id: "rechnungen",
  groupKey: "rechnungen.search.group",
  async search(query, signal) {
    const q = query.trim();
    if (!q) return [];
    const res = await fetch(`/invoices?kind=invoice&limit=${LIMIT}&q=${encodeURIComponent(q)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) throw new Error(`Suche fehlgeschlagen (${res.status})`);
    const body = (await res.json()) as { items: Invoice[] };
    return body.items.map<SearchHit>((inv) => {
      const status = displayStatus(inv, 0);
      return {
        id: inv.id,
        title: invoiceName(inv),
        subtitle: inv.debtor.name,
        kind: t("rechnungen.search.kind"),
        status: { label: statusLabel(status), tone: statusTone[status] },
        icon: "invoice",
        open: {
          tabType: "rechnung",
          key: inv.id,
          params: { id: inv.id },
          title: t("rechnungen.detail.tab", { name: invoiceName(inv) }),
        },
      };
    });
  },
};
