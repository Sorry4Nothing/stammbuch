/**
 * Rechnungen, die gebucht wurden, deren Mail aber nicht in die Versandqueue kam («Nicht zugestellt»). Die API
 * speichert diesen Zustand nicht; er liegt deshalb im Browser (nur Rechnungs-ID und Zeitpunkt) und gilt nur dort.
 * shortcut: pro Browser statt pro Mandant, bis die API den Zustand an der Rechnung führt.
 */
const KEY = "stammbuch.rechnungen.undelivered";

function read(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Speicher gesperrt oder voll: die Anzeige entfällt, die Rechnung bleibt unberührt
  }
}

/** ISO-Zeitpunkt des fehlgeschlagenen Versands, sonst `null`. */
export function undeliveredAt(invoiceId: string): string | null {
  return read()[invoiceId] ?? null;
}

export function markUndelivered(invoiceId: string, at: string = new Date().toISOString()) {
  write({ ...read(), [invoiceId]: at });
}

export function clearUndelivered(invoiceId: string) {
  const map = read();
  delete map[invoiceId];
  write(map);
}
