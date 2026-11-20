-- Mehrwertsteuerpflicht des Mandanten (#205). Gewisse Firmen und Vereine sind von der Mehrwertsteuer befreit; die Organisation
-- führt dafür den Schalter "Mehrwertsteuerpflichtig" (JSON-Abschnitt master). Die Rechnungseinstellungen tragen eine Kopie, damit
-- der Rechnungsservice die Pflicht ohne Zugriff auf die Organisation erzwingen kann. Nur additiv; Standard "pflichtig", damit sich
-- bestehende Mandanten nicht ändern. Bereits versendete Belege bleiben unverändert (der Beleg trägt seinen eigenen mwst_modus).
-- Zeilensicherheit und Rechte gelten tabellenweit und decken die neue Spalte ab.

ALTER TABLE rechnung_einstellung
  ADD COLUMN mwst_pflichtig boolean NOT NULL DEFAULT true;
