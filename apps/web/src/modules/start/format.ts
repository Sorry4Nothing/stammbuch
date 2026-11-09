/** «2026-11-02» wird «02.11.2026». */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** Rappen als «CHF 1'250.00» (Apostroph als Tausendertrenner, zwei Nachkommastellen), auch für andere Währungscodes. */
export function formatChf(cents: number, currency = "CHF"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const francs = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${currency} ${sign}${francs}.${String(abs % 100).padStart(2, "0")}`;
}
