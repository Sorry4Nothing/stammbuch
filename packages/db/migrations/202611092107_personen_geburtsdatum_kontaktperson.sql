-- Selbstregistrierung: Geburtsdatum der Person und Kontaktperson der Firma (#107).
-- Additiv und mit IF NOT EXISTS, weil der parallele Branch zu #108 dieselben Spalten braucht.
-- Beide sind optional. RLS und GRANT der Tabellen gelten unverändert für die neuen Spalten.

ALTER TABLE mitglied
  ADD COLUMN IF NOT EXISTS geburtsdatum date CHECK (geburtsdatum >= DATE '1900-01-01');

ALTER TABLE firma
  ADD COLUMN IF NOT EXISTS kontaktperson text CHECK (length(kontaktperson) BETWEEN 1 AND 120);
