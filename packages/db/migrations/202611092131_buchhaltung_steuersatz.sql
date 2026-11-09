-- MwSt (#131): Ein Konto kann einen Steuersatz tragen (Basispunkte: 260 = 2.6 %, 380 = 3.8 %, 810 = 8.1 %; NULL = ohne
-- Steuer). Buchungszeilen halten den Satz fest, den das Konto zum Buchungszeitpunkt trug; Bestandszeilen bleiben NULL.
-- Der Hash der Buchung ändert sich dadurch nur für neue Zeilen mit Satz. Periodenabschluss: die Person bestätigt die
-- MwSt-Abrechnung je Periode (Zeitpunkt, Akteur und die bestätigten Beträge).

ALTER TABLE buchhaltung_konto
  ADD COLUMN steuersatz_bp smallint CHECK (steuersatz_bp IN (260, 380, 810)),
  ADD CONSTRAINT konto_steuersatz_art CHECK (steuersatz_bp IS NULL OR art <> 'equity');

ALTER TABLE buchhaltung_buchungszeile
  ADD COLUMN steuersatz_bp smallint CHECK (steuersatz_bp IN (260, 380, 810));

-- Name und Aktiv-Flag waren die einzigen änderbaren Spalten; neu auch der Steuersatz.
GRANT UPDATE (steuersatz_bp) ON buchhaltung_konto TO stammbuch_app;

ALTER TABLE auswertung_periode ADD COLUMN mwst_bestaetigung jsonb;
GRANT UPDATE (mwst_bestaetigung) ON auswertung_periode TO stammbuch_app;
