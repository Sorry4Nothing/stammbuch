-- Erlöskonto je Rechnungsposition und Standard-Erlöskonto je Kunde (#67).
-- Nur additiv und ohne Auswirkung auf bestehende Zeilen: NULL heisst "Konto der bisherigen Regel" (Sammelrechnung 3000,
-- sonst 3400). Bereits gebuchte Belege bleiben unverändert; der Positions-Trigger sperrt Änderungen an versendeten
-- Belegen weiterhin. Die Prüfung gegen den Kontenplan des Kunden macht die Anwendung (der Kontenplan liegt je Kunde in
-- der Buchhaltung); die Datenbank sichert nur die Form der Kontonummer.

ALTER TABLE rechnung_position
  ADD COLUMN erloeskonto text CHECK (erloeskonto ~ '^[0-9]{4,6}$');

ALTER TABLE rechnung_einstellung
  ADD COLUMN erloeskonto_standard text CHECK (erloeskonto_standard ~ '^[0-9]{4,6}$');
