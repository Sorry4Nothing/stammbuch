-- Rechnungen und Gutschriften samt Positionen (Modul Rechnungen). Beträge nur als ganzzahlige Rappen (bigint).
-- Ab Status "versendet" ist ein Beleg unveränderlich: nur status, version und geaendert_am dürfen sich noch ändern
-- (Zahlungsstand, Storno). Die Trigger gelten auch für den Eigentümer; die Anwendung kann sie nicht umgehen.

CREATE TABLE rechnung (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id          uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  art               text NOT NULL CHECK (art IN ('rechnung', 'gutschrift')),
  status            text NOT NULL CHECK (status IN ('entwurf', 'versendet', 'bezahlt', 'storniert')),
  -- Erst beim Versenden vergeben, lückenlos je Kunde, Art und Jahr (Tabelle nummernkreis).
  nummer            text CHECK (length(nummer) BETWEEN 1 AND 40),
  laufnummer        integer CHECK (laufnummer BETWEEN 1 AND 999999),
  kundennummer      text CHECK (length(kundennummer) <= 64),
  debitor           jsonb NOT NULL,
  waehrung          text NOT NULL CHECK (waehrung IN ('CHF', 'EUR')),
  rechnungsdatum    date NOT NULL,
  faelligkeitsdatum date NOT NULL,
  jahr              integer GENERATED ALWAYS AS (EXTRACT(year FROM rechnungsdatum)::integer) STORED,
  mwst_modus        text NOT NULL CHECK (mwst_modus IN ('ohne', 'exklusiv')),
  runden_5          boolean NOT NULL,
  betreff           text NOT NULL CHECK (length(betreff) <= 200),
  notizen           text NOT NULL CHECK (length(notizen) <= 2000),
  netto_rappen      bigint NOT NULL,
  mwst_rappen       bigint NOT NULL,
  brutto_rappen     bigint NOT NULL,
  rundung_rappen    bigint NOT NULL,
  total_rappen      bigint NOT NULL CHECK (abs(total_rappen) <= 99999999999),
  mwst_saetze       jsonb NOT NULL,
  referenz_art      text CHECK (referenz_art IN ('QRR', 'SCOR', 'NON')),
  referenz          text CHECK (length(referenz) BETWEEN 1 AND 27),
  gutschrift_zu     uuid,
  sammellauf_id     uuid,
  zahler_key        text CHECK (length(zahler_key) <= 64),
  versendet_am      timestamptz,
  erstellt_am       timestamptz NOT NULL,
  geaendert_am      timestamptz NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  UNIQUE (id, kunde_id),
  CHECK ((status = 'entwurf') = (nummer IS NULL)),
  CHECK ((nummer IS NULL) = (laufnummer IS NULL)),
  CHECK ((nummer IS NULL) = (versendet_am IS NULL)),
  CHECK ((art = 'gutschrift') = (gutschrift_zu IS NOT NULL)),
  CHECK ((sammellauf_id IS NULL) = (zahler_key IS NULL)),
  CHECK (total_rappen = brutto_rappen + rundung_rappen),
  CHECK (faelligkeitsdatum >= rechnungsdatum),
  -- Eine Gutschrift gehört zu einer Rechnung desselben Kunden (Fremdschlüsselprüfungen laufen an RLS vorbei).
  FOREIGN KEY (gutschrift_zu, kunde_id) REFERENCES rechnung (id, kunde_id)
);

-- Lückenlose Nummern: keine Nummer doppelt, auch nicht bei Programmfehlern.
CREATE UNIQUE INDEX rechnung_nummer_idx ON rechnung (kunde_id, nummer) WHERE nummer IS NOT NULL;
CREATE UNIQUE INDEX rechnung_laufnummer_idx ON rechnung (kunde_id, art, jahr, laufnummer) WHERE laufnummer IS NOT NULL;
-- Sammelrechnung: ein Zahler pro Lauf nur einmal (Idempotenz).
CREATE UNIQUE INDEX rechnung_sammellauf_idx ON rechnung (kunde_id, sammellauf_id, zahler_key) WHERE sammellauf_id IS NOT NULL;
CREATE INDEX rechnung_status_idx ON rechnung (kunde_id, status, art);
CREATE INDEX rechnung_erstellt_idx ON rechnung (kunde_id, erstellt_am DESC, id DESC);
CREATE INDEX rechnung_referenz_idx ON rechnung (kunde_id, referenz) WHERE referenz IS NOT NULL;
CREATE INDEX rechnung_gutschrift_zu_idx ON rechnung (gutschrift_zu) WHERE gutschrift_zu IS NOT NULL;

CREATE TABLE rechnung_position (
  rechnung_id        uuid NOT NULL,
  pos                integer NOT NULL CHECK (pos >= 1),
  kunde_id           uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  beschreibung       text NOT NULL CHECK (length(beschreibung) BETWEEN 1 AND 500),
  -- Menge in Tausendsteln (1500 = 1.5 Einheiten).
  menge_milli        integer NOT NULL CHECK (menge_milli > 0),
  einzelpreis_rappen bigint NOT NULL,
  -- MwSt-Satz in Basispunkten (810 = 8.1 %).
  mwst_satz_bp       integer NOT NULL CHECK (mwst_satz_bp BETWEEN 0 AND 2500),
  PRIMARY KEY (rechnung_id, pos),
  FOREIGN KEY (rechnung_id, kunde_id) REFERENCES rechnung (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX rechnung_position_kunde_idx ON rechnung_position (kunde_id);

-- Unveränderlichkeit -----------------------------------------------------------------------------
-- pg_trigger_depth() > 1: Löschen im Zuge von ON DELETE CASCADE (Vertragsende, nur durch den Eigentümer).

CREATE FUNCTION rechnung_schuetzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'entwurf' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'Versendete Belege werden nie gelöscht' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'entwurf' THEN
    IF NEW.status = 'entwurf' THEN
      RAISE EXCEPTION 'Ein versendeter Beleg wird nicht zum Entwurf' USING ERRCODE = 'restrict_violation';
    END IF;
    -- "jahr" ist berechnet und in NEW noch nicht gesetzt: ausnehmen (folgt aus rechnungsdatum, das geschützt ist).
    IF to_jsonb(OLD) - 'status' - 'version' - 'geaendert_am' - 'jahr' IS DISTINCT FROM to_jsonb(NEW) - 'status' - 'version' - 'geaendert_am' - 'jahr' THEN
      RAISE EXCEPTION 'Versendete Belege sind unveränderlich' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  -- Optimistisches Sperren auch auf Datenbankebene: jede Änderung zählt die Version um genau eins hoch.
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Version muss um 1 steigen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER rechnung_schuetzen
  BEFORE UPDATE OR DELETE ON rechnung
  FOR EACH ROW EXECUTE FUNCTION rechnung_schuetzen();

CREATE FUNCTION rechnung_position_schuetzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status text;
  parent_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.rechnung_id ELSE NEW.rechnung_id END;
BEGIN
  SELECT status INTO parent_status FROM public.rechnung WHERE id = parent_id;
  -- Beleg nicht (mehr) vorhanden: Löschen im Zuge des Kaskadierens.
  IF parent_status IS NOT NULL AND parent_status <> 'entwurf' THEN
    RAISE EXCEPTION 'Positionen versendeter Belege sind unveränderlich' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER rechnung_position_schuetzen
  BEFORE INSERT OR UPDATE OR DELETE ON rechnung_position
  FOR EACH ROW EXECUTE FUNCTION rechnung_position_schuetzen();

-- Zeilensicherheit --------------------------------------------------------------------------------

ALTER TABLE rechnung ENABLE ROW LEVEL SECURITY;
ALTER TABLE rechnung_position ENABLE ROW LEVEL SECURITY;

CREATE POLICY rechnung_lesen ON rechnung FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY rechnung_anlegen ON rechnung FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY rechnung_aendern ON rechnung FOR UPDATE TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));
-- Gelöscht werden nur Entwürfe.
CREATE POLICY rechnung_loeschen ON rechnung FOR DELETE TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()) AND status = 'entwurf');

CREATE POLICY rechnung_position_eigener_kunde ON rechnung_position FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON rechnung TO stammbuch_app;
GRANT SELECT, INSERT, DELETE ON rechnung_position TO stammbuch_app;
