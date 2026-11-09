import { afterEach, describe, expect, it, vi } from "vitest";
import { rechnungenSearch } from "./search";

afterEach(() => vi.unstubAllGlobals());

describe("Rechnungssuche", () => {
  it("fragt die Rechnungsliste mit Suchbegriff ab und liefert Treffer mit Status", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [
          {
            id: "i1",
            kind: "invoice",
            status: "sent",
            number: "RE-2026-0002",
            debtor: { name: "Erika Beispiel" },
            creditedCents: 0,
            openCents: 100,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const hits = await rechnungenSearch.search("erika & co", new AbortController().signal);
    expect(fetchMock.mock.calls[0]![0]).toBe("/invoices?kind=invoice&limit=8&q=erika%20%26%20co");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "RE-2026-0002",
      subtitle: "Erika Beispiel",
      status: { label: "Offen" },
      open: { tabType: "rechnung", key: "i1", params: { id: "i1" } },
    });
  });

  it("wirft bei einem Fehler der Schnittstelle, damit die Suche «unvollständig» meldet", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    await expect(rechnungenSearch.search("x", new AbortController().signal)).rejects.toThrow();
  });
});
