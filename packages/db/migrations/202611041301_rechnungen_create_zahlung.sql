-- Zahlungen zu Rechnungen: nur anhängend. Eine Rückbuchung ist eine Zahlung mit negativem Betrag.

CREATE TABLE rechnung_zahlung (
  id            uuid PRIMARY KEY,
  lfd           bigint GENERATED ALWAYS AS IDENTITY,
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  rechnung_id   uuid NOT NULL,
  betrag_rappen bigint NOT NULL CHECK (betrag_rappen <> 0 AND abs(betrag_rappen) <= 99999999999),
  bezahlt_am    date NOT NULL,
  erfasst_am    timestamptz NOT NULL,
  -- Benutzer-ID oder Systemkennung (z. B. Bankimport).
  erfasst_von   text NOT NULL CHECK (length(erfasst_von) BETWEEN 1 AND 100),
  FOREIGN KEY (rechnung_id, kunde_id) REFERENCES rechnung (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX rechnung_zahlung_rechnung_idx ON rechnung_zahlung (rechnung_id, lfd);
CREATE INDEX rechnung_zahlung_kunde_idx ON rechnung_zahlung (kunde_id);

-- Wiederverwendbar für alle anhängenden Tabellen. Löschen im Zuge von ON DELETE CASCADE (Vertragsende,
-- nur durch den Eigentümer) bleibt möglich: pg_trigger_depth() > 1.
CREATE FUNCTION nur_anhaengen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% ist nur anhängend', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER rechnung_zahlung_nur_anhaengen
  BEFORE UPDATE OR DELETE ON rechnung_zahlung
  FOR EACH ROW EXECUTE FUNCTION nur_anhaengen();

-- Zahlungen gibt es nur zu versendeten Rechnungen (nicht zu Entwürfen und Gutschriften).
CREATE FUNCTION rechnung_zahlung_pruefen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_art text;
  parent_status text;
BEGIN
  SELECT art, status INTO parent_art, parent_status FROM public.rechnung WHERE id = NEW.rechnung_id;
  IF parent_art IS NOT NULL AND (parent_art <> 'rechnung' OR parent_status = 'entwurf') THEN
    RAISE EXCEPTION 'Zahlungen gibt es nur zu versendeten Rechnungen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER rechnung_zahlung_pruefen
  BEFORE INSERT ON rechnung_zahlung
  FOR EACH ROW EXECUTE FUNCTION rechnung_zahlung_pruefen();

ALTER TABLE rechnung_zahlung ENABLE ROW LEVEL SECURITY;

CREATE POLICY rechnung_zahlung_lesen ON rechnung_zahlung FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY rechnung_zahlung_anhaengen ON rechnung_zahlung FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON rechnung_zahlung TO stammbuch_app;
