-- Journal: Buchung (Kopf) und Buchungszeilen. Nur anhängend, lückenlose Belegnummern, Hash-Kette,
-- Soll = Haben beim Commit, gesperrte Perioden.

CREATE TABLE buchhaltung_buchung (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id         uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  belegnummer      bigint NOT NULL CHECK (belegnummer >= 1),
  buchungsdatum    date NOT NULL,
  art              text NOT NULL CHECK (art IN ('manual', 'invoice', 'credit_note', 'payment', 'reversal')),
  beschreibung     text NOT NULL CHECK (length(beschreibung) BETWEEN 1 AND 200),
  storno_von       uuid,
  erstellt_am      timestamptz NOT NULL,
  erstellt_von     text NOT NULL CHECK (length(erstellt_von) BETWEEN 1 AND 100),
  -- 31.12. des Buchungsjahres + 10 Jahre (Art. 958f OR).
  aufbewahren_bis  date NOT NULL,
  vorgaenger_hash  text NOT NULL CHECK (vorgaenger_hash ~ '^[0-9a-f]{64}$'),
  -- SHA-256 über Inhalt und vorgaenger_hash, in der Anwendung berechnet; die Datenbank prüft die Kette.
  hash             text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- Zeilen dürfen nur in der Transaktion ihrer Buchung entstehen (siehe buchungszeile).
  transaktions_id  xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (kunde_id, belegnummer),
  UNIQUE (kunde_id, id),
  FOREIGN KEY (kunde_id, storno_von) REFERENCES buchhaltung_buchung (kunde_id, id),
  CHECK ((art = 'reversal') = (storno_von IS NOT NULL)),
  CHECK (aufbewahren_bis = make_date(extract(year FROM buchungsdatum)::int + 10, 12, 31))
);

-- Höchstens eine Gegenbuchung je Buchung.
CREATE UNIQUE INDEX buchung_eine_gegenbuchung_idx ON buchhaltung_buchung (kunde_id, storno_von)
  WHERE storno_von IS NOT NULL;
CREATE INDEX buchung_datum_idx ON buchhaltung_buchung (kunde_id, buchungsdatum);

CREATE TABLE buchhaltung_buchungszeile (
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  buchung_id     uuid NOT NULL,
  zeilennr       smallint NOT NULL CHECK (zeilennr >= 1),
  konto_nummer   text NOT NULL,
  seite          text NOT NULL CHECK (seite IN ('debit', 'credit')),
  -- Ganze Rappen.
  betrag         bigint NOT NULL CHECK (betrag > 0 AND betrag <= 1000000000000),
  person_id      text CHECK (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  PRIMARY KEY (kunde_id, buchung_id, zeilennr),
  FOREIGN KEY (kunde_id, buchung_id) REFERENCES buchhaltung_buchung (kunde_id, id),
  FOREIGN KEY (kunde_id, konto_nummer) REFERENCES buchhaltung_konto (kunde_id, nummer),
  -- Debitoren-Sammelkonto 1100: immer mit Person; alle anderen Konten: nie.
  CHECK ((konto_nummer = '1100') = (person_id IS NOT NULL))
);

CREATE INDEX buchungszeile_konto_idx ON buchhaltung_buchungszeile (kunde_id, konto_nummer);
CREATE INDEX buchungszeile_person_idx ON buchhaltung_buchungszeile (kunde_id, person_id) WHERE person_id IS NOT NULL;

-- Belegnummer lückenlos, Hash-Kette, gesperrte Periode.
CREATE FUNCTION buchhaltung_buchung_vor_einfuegen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  letzte_nummer bigint;
  letzter_hash text;
  periodenstatus text;
BEGIN
  PERFORM buchhaltung_sperre(new.kunde_id);

  SELECT b.belegnummer, b.hash INTO letzte_nummer, letzter_hash
  FROM public.buchhaltung_buchung b
  WHERE b.kunde_id = new.kunde_id
  ORDER BY b.belegnummer DESC LIMIT 1;

  IF new.belegnummer <> coalesce(letzte_nummer, 0) + 1 THEN
    RAISE EXCEPTION 'Belegnummer % ist nicht die nächste (erwartet %)', new.belegnummer, coalesce(letzte_nummer, 0) + 1
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF new.vorgaenger_hash <> coalesce(letzter_hash, repeat('0', 64)) THEN
    RAISE EXCEPTION 'Hash-Kette unterbrochen bei Beleg %', new.belegnummer
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT p.status INTO periodenstatus
  FROM public.buchhaltung_periodenereignis p
  WHERE p.kunde_id = new.kunde_id AND p.periode = to_char(new.buchungsdatum, 'YYYY-MM')
  ORDER BY p.lfd DESC LIMIT 1;
  IF periodenstatus = 'closed' THEN
    RAISE EXCEPTION 'Periode % ist abgeschlossen', to_char(new.buchungsdatum, 'YYYY-MM')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN new;
END
$$;

-- Zeilen nur in der Transaktion der Buchung: niemand hängt später eine Zeile an eine bestehende Buchung.
CREATE FUNCTION buchhaltung_zeile_vor_einfuegen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM public.buchhaltung_buchung b
    WHERE b.id = new.buchung_id AND b.kunde_id = new.kunde_id AND b.transaktions_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'Zeilen sind nur in der Transaktion ihrer Buchung erlaubt'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN new;
END
$$;

-- Soll = Haben und mindestens zwei Zeilen: geprüft beim Commit (aufgeschoben), wenn alle Zeilen da sind.
CREATE FUNCTION buchhaltung_buchung_ausgeglichen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  soll bigint;
  haben bigint;
  anzahl int;
BEGIN
  SELECT coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'debit'), 0),
         coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'credit'), 0),
         count(*)
  INTO soll, haben, anzahl
  FROM public.buchhaltung_buchungszeile z
  WHERE z.kunde_id = new.kunde_id AND z.buchung_id = new.id;
  IF anzahl < 2 OR soll <> haben THEN
    RAISE EXCEPTION 'Buchung % ist nicht ausgeglichen (Soll %, Haben %, % Zeilen)', new.belegnummer, soll, haben, anzahl
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER buchung_a_vor_einfuegen BEFORE INSERT ON buchhaltung_buchung
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_buchung_vor_einfuegen();
CREATE CONSTRAINT TRIGGER buchung_ausgeglichen AFTER INSERT ON buchhaltung_buchung
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION buchhaltung_buchung_ausgeglichen();
CREATE TRIGGER zeile_vor_einfuegen BEFORE INSERT ON buchhaltung_buchungszeile
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_zeile_vor_einfuegen();

CREATE TRIGGER buchung_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_buchung
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER buchungszeile_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_buchungszeile
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER buchung_kein_truncate BEFORE TRUNCATE ON buchhaltung_buchung
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER buchungszeile_kein_truncate BEFORE TRUNCATE ON buchhaltung_buchungszeile
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();

ALTER TABLE buchhaltung_buchung ENABLE ROW LEVEL SECURITY;
ALTER TABLE buchhaltung_buchungszeile ENABLE ROW LEVEL SECURITY;

CREATE POLICY buchung_lesen ON buchhaltung_buchung
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY buchung_anhaengen ON buchhaltung_buchung
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY buchungszeile_lesen ON buchhaltung_buchungszeile
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY buchungszeile_anhaengen ON buchhaltung_buchungszeile
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON buchhaltung_buchung, buchhaltung_buchungszeile TO stammbuch_app;
