import { describe, expect, it, vi } from "vitest";
import { type CalendarRetentionPort, purgeEndedEvents } from "./calendar-retention.js";

const NOW = new Date("2026-12-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Gemeinsamer Datenspeicher: Kalender und Buchhaltung liegen nebeneinander. */
function makeStore() {
  const store = {
    events: [
      { id: "alt", endsAt: hoursAgo(30) },
      { id: "genau24", endsAt: hoursAgo(24) },
      { id: "knapp", endsAt: hoursAgo(23.99) },
      { id: "laufend", endsAt: new Date(NOW.getTime() + 3_600_000) },
    ],
    invitations: [
      { id: "i1", eventId: "alt" },
      { id: "i2", eventId: "knapp" },
    ],
    responses: [
      { id: "r1", eventId: "alt" },
      { id: "r2", eventId: "genau24" },
      { id: "r3", eventId: "knapp" },
    ],
    invoices: [
      { id: "rg1", eventId: "alt", amount: 120 },
      { id: "rg2", eventId: null, amount: 80 },
    ],
    ledger: [{ id: "b1", invoiceId: "rg1" }],
  };
  const port: CalendarRetentionPort = {
    findEventIdsEndedBefore: async (cutoff) =>
      store.events.filter((e) => e.endsAt <= cutoff).map((e) => e.id),
    deleteEventData: async (id) => {
      store.events = store.events.filter((e) => e.id !== id);
      store.invitations = store.invitations.filter((i) => i.eventId !== id);
      store.responses = store.responses.filter((r) => r.eventId !== id);
    },
  };
  return { store, port };
}

describe("purgeEndedEvents", () => {
  it("löscht Event und Zu-/Absagen nach 24 Stunden, nicht früher", async () => {
    const { store, port } = makeStore();
    const deleted = await purgeEndedEvents(port, NOW, () => {});
    expect(deleted).toBe(2);
    expect(store.events.map((e) => e.id)).toEqual(["knapp", "laufend"]);
    expect(store.responses.map((r) => r.id)).toEqual(["r3"]);
    expect(store.invitations.map((i) => i.id)).toEqual(["i2"]);
  });

  it("fasst Rechnungen und Buchhaltung nie an", async () => {
    const { store, port } = makeStore();
    const invoicesBefore = structuredClone(store.invoices);
    const ledgerBefore = structuredClone(store.ledger);
    await purgeEndedEvents(port, NOW, () => {});
    // Auch eine Rechnung, die auf ein gelöschtes Event verweist, bleibt unverändert.
    expect(store.invoices).toEqual(invoicesBefore);
    expect(store.ledger).toEqual(ledgerBefore);
  });

  it("ruft nur die beiden Port-Operationen auf", async () => {
    const find = vi.fn(async () => ["alt"]);
    const del = vi.fn(async () => {});
    await purgeEndedEvents({ findEventIdsEndedBefore: find, deleteEventData: del }, NOW, () => {});
    expect(find).toHaveBeenCalledWith(hoursAgo(24));
    expect(del).toHaveBeenCalledExactlyOnceWith("alt");
  });

  it("meldet Fehler pro Event und löscht die übrigen weiter", async () => {
    const { store, port } = makeStore();
    const failing: CalendarRetentionPort = {
      findEventIdsEndedBefore: port.findEventIdsEndedBefore,
      deleteEventData: async (id) => {
        if (id === "alt") throw new Error("DB weg");
        return port.deleteEventData(id);
      },
    };
    const onError = vi.fn();
    const deleted = await purgeEndedEvents(failing, NOW, onError);
    expect(deleted).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBe("alt");
    expect(store.events.map((e) => e.id)).toContain("alt");
  });
});
