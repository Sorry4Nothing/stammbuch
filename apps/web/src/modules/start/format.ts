/** «2026-11-02» wird «02.11.2026». */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** Rappen als «CHF 1'250.00», auch für andere Währungscodes (ui/format). */
export { formatChf } from "../../ui/format";
