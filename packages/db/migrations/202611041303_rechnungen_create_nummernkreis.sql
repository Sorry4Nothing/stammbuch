-- Lückenloser Nummernkreis je Kunde, Belegart und Jahr. Vergabe atomar:
--   INSERT ... ON CONFLICT DO UPDATE SET letzte_nummer = letzte_nummer + 1 RETURNING letzte_nummer
-- Die Zeilensperre hält bis zum Ende der Transaktion; wird sie zurückgerollt, wird die Nummer nicht verbraucht.
-- Darum muss die Vergabe in derselben Transaktion liegen wie das Versenden des Belegs.

CREATE TABLE nummernkreis (
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  art           text NOT NULL CHECK (art IN ('rechnung', 'gutschrift')),
  jahr          integer NOT NULL CHECK (jahr BETWEEN 2000 AND 9999),
  letzte_nummer integer NOT NULL CHECK (letzte_nummer BETWEEN 1 AND 1000000),
  PRIMARY KEY (kunde_id, art, jahr)
);

-- Der Zähler läuft nur vorwärts, in Einerschritten.
CREATE FUNCTION nummernkreis_schuetzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.letzte_nummer <> OLD.letzte_nummer + 1 OR NEW.kunde_id <> OLD.kunde_id OR NEW.art <> OLD.art OR NEW.jahr <> OLD.jahr THEN
    RAISE EXCEPTION 'Nummernkreis läuft nur in Einerschritten vorwärts' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER nummernkreis_schuetzen
  BEFORE UPDATE ON nummernkreis
  FOR EACH ROW EXECUTE FUNCTION nummernkreis_schuetzen();

ALTER TABLE nummernkreis ENABLE ROW LEVEL SECURITY;

CREATE POLICY nummernkreis_eigener_kunde ON nummernkreis FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE ON nummernkreis TO stammbuch_app;
