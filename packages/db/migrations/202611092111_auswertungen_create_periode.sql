-- Perioden der Auswertungen (Periodenabschluss, #111): Zeitraum, Zustand, Prüfbefunde und Verlauf je Kunde.
-- Eine abgeschlossene Periode ist endgültig: Trigger verweigern Änderung und Löschen, auch dem Eigentümer.
-- Das Löschen im Zuge von ON DELETE CASCADE (Vertragsende) bleibt möglich. Die Sperre gegen Überschneidungen
-- prüft die Anwendung; die Datenbank verhindert nur zwei Perioden mit demselben Beginn.

CREATE TABLE auswertung_periode (
  id                  uuid PRIMARY KEY,
  kunde_id            uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  bezeichnung         text NOT NULL CHECK (length(bezeichnung) BETWEEN 1 AND 100),
  von                 date NOT NULL,
  bis                 date NOT NULL,
  status              text NOT NULL CHECK (status IN ('open', 'checked', 'closed')),
  -- Optimistische Sperre: steigt bei jeder Speicherung um genau eins.
  version             integer NOT NULL CHECK (version >= 1),
  -- Befunde der letzten Prüfung (Code, Schwere, fester Satz) und Statuswechsel (Zeitpunkt, Akteur, von, nach).
  befunde             jsonb NOT NULL,
  verlauf             jsonb NOT NULL,
  -- SHA-256 der Buchungszeilen zum Zeitpunkt der erfolgreichen Prüfung; nur in geprüften und abgeschlossenen Perioden.
  pruef_fingerabdruck text CHECK (pruef_fingerabdruck ~ '^[0-9a-f]{64}$'),
  UNIQUE (kunde_id, id),
  UNIQUE (kunde_id, von),
  CHECK (bis >= von),
  CHECK ((status = 'open') = (pruef_fingerabdruck IS NULL))
);

CREATE FUNCTION auswertung_periode_schuetzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'Abgeschlossene Perioden werden nie gelöscht' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Abgeschlossene Perioden sind unveränderlich' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kunde_id <> OLD.kunde_id OR NEW.von <> OLD.von OR NEW.bis <> OLD.bis
     OR NEW.bezeichnung <> OLD.bezeichnung THEN
    RAISE EXCEPTION 'Zeitraum und Bezeichnung einer Periode ändern sich nicht' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Version muss um 1 steigen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER auswertung_periode_schuetzen
  BEFORE UPDATE OR DELETE ON auswertung_periode
  FOR EACH ROW EXECUTE FUNCTION auswertung_periode_schuetzen();

ALTER TABLE auswertung_periode ENABLE ROW LEVEL SECURITY;

CREATE POLICY auswertung_periode_lesen ON auswertung_periode FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY auswertung_periode_anlegen ON auswertung_periode FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY auswertung_periode_aendern ON auswertung_periode FOR UPDATE TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein DELETE für die Anwendungsrolle; geändert werden nur Zustand, Befunde, Verlauf und Fingerabdruck.
GRANT SELECT, INSERT ON auswertung_periode TO stammbuch_app;
GRANT UPDATE (status, version, befunde, verlauf, pruef_fingerabdruck) ON auswertung_periode TO stammbuch_app;
