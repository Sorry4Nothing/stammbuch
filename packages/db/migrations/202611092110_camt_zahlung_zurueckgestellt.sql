-- Restposten zurückstellen: ein Mensch markiert eine Zahlung, die er später zuordnen will.
-- Die Zahlung bleibt ein Restposten (Status REST) und wird weiter gelistet; nur die Markierung ist neu.
-- Zuordnen (Status MANUAL) löscht die Markierung, die CHECK-Bedingung stellt das sicher.

ALTER TABLE camt_zahlung
  ADD COLUMN zurueckgestellt_am  timestamptz,
  ADD COLUMN zurueckgestellt_von uuid,
  ADD CONSTRAINT camt_zahlung_zurueckgestellt_nur_rest
    CHECK (zurueckgestellt_am IS NULL OR status = 'REST'),
  ADD CONSTRAINT camt_zahlung_zurueckgestellt_von_fk
    FOREIGN KEY (zurueckgestellt_von, kunde_id) REFERENCES benutzer (id, kunde_id);

-- Die bestehende Policy camt_zahlung_zuordnen (UPDATE, kunde_id = Kunde der Sitzung) gilt auch hier.
GRANT UPDATE (zurueckgestellt_am, zurueckgestellt_von) ON camt_zahlung TO stammbuch_app;
