-- Referenz der Selbstregistrierung (XXXX-XXXX) am Datensatz (#130). Sie folgt wie bisher aus dem Hash des Tokens und
-- steht in Formular, Bestätigungsmail und Eingangsbestätigung; neu ist, dass sie am Mitglied bzw. an der Firma
-- gespeichert wird, damit eine Rückfrage mit der Referenz den Datensatz findet. NULL: nicht per Selbstregistrierung
-- entstanden (oder vor diesem Feld). Je Kunde nur einmal, getrennt für Mitglieder und Firmen; die Anwendung prüft
-- ausserdem über beide Tabellen, bevor sie eine Referenz ausgibt.
-- Die Suche (suchtext) bleibt unverändert; die Anwendung sucht die Referenz zusätzlich in dieser Spalte.

ALTER TABLE mitglied
  ADD COLUMN registrierung_referenz text CHECK (registrierung_referenz ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$');
ALTER TABLE firma
  ADD COLUMN registrierung_referenz text CHECK (registrierung_referenz ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$');

CREATE UNIQUE INDEX mitglied_registrierung_referenz_key ON mitglied (kunde_id, registrierung_referenz)
  WHERE registrierung_referenz IS NOT NULL;
CREATE UNIQUE INDEX firma_registrierung_referenz_key ON firma (kunde_id, registrierung_referenz)
  WHERE registrierung_referenz IS NOT NULL;
