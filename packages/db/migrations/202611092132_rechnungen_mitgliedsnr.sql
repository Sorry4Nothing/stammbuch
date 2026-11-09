-- Mitgliedsnummer in der Rechnung (#132). Momentaufnahme der Nummer der Person (mitglied.mitgliedsnr, Format M-1001) beim
-- Erfassen des Belegs: die Rechnung behält sie, auch wenn die Person später bearbeitet oder archiviert wird. Nur additiv;
-- NULL heisst "keine Nummer bekannt" (Firmen, Belege vor dieser Migration). Bereits versendete Belege werden nicht nachträglich
-- ergänzt: der Trigger rechnung_schuetzen sperrt sie, und ein Beleg ändert sich nach dem Versenden nicht mehr.
-- Zeilensicherheit und Rechte gelten tabellenweit und decken die neue Spalte ab.

ALTER TABLE rechnung
  ADD COLUMN mitgliedsnr text CHECK (length(mitgliedsnr) BETWEEN 1 AND 40);
