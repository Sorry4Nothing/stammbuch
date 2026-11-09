-- Ergebnis eines Protokolleintrags (#130): Erfolg oder Fehler. Nur additiv, vorhandene Einträge gelten als Erfolg.
-- Die Anwendungsrolle bleibt bei SELECT und INSERT: das Ergebnis lässt sich nach dem Anhängen nicht mehr ändern.

ALTER TABLE audit_log
  ADD COLUMN ergebnis text NOT NULL DEFAULT 'erfolg' CHECK (ergebnis IN ('erfolg', 'fehler'));

-- Das Auth-Modul hat das Ergebnis bisher in details.ergebnis (success / failure) abgelegt: übernehmen.
UPDATE audit_log SET ergebnis = 'fehler' WHERE details ->> 'ergebnis' = 'failure';
