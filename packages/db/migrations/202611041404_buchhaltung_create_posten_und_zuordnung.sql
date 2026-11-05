-- Offene Posten (Rechnungen), Guthaben (Zahlungen und Gutschriften) und ihre Zuordnungen. Nur anhängend.
-- Der Zustand (offen, bezahlt, storniert) wird aus den Zuordnungen und der Gegenbuchung abgeleitet,
-- nie als veränderbares Feld gespeichert. lfd gibt die Einfügereihenfolge (gleiche Zeitstempel).

CREATE TABLE buchhaltung_offener_posten (
  lfd          bigint GENERATED ALWAYS AS IDENTITY,
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id     uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  person_id    text NOT NULL CHECK (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  referenz     text NOT NULL CHECK (length(referenz) BETWEEN 1 AND 60),
  belegdatum   date NOT NULL,
  faellig_am   date NOT NULL CHECK (faellig_am >= belegdatum),
  betrag       bigint NOT NULL CHECK (betrag > 0 AND betrag <= 1000000000000),
  buchung_id   uuid NOT NULL,
  erstellt_am  timestamptz NOT NULL,
  UNIQUE (kunde_id, id),
  UNIQUE (kunde_id, buchung_id),
  FOREIGN KEY (kunde_id, buchung_id) REFERENCES buchhaltung_buchung (kunde_id, id)
);
CREATE INDEX offener_posten_person_idx ON buchhaltung_offener_posten (kunde_id, person_id, faellig_am);

CREATE TABLE buchhaltung_guthaben (
  lfd          bigint GENERATED ALWAYS AS IDENTITY,
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id     uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  art          text NOT NULL CHECK (art IN ('payment', 'credit_note')),
  person_id    text NOT NULL CHECK (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  referenz     text NOT NULL CHECK (length(referenz) BETWEEN 1 AND 60),
  valuta       date NOT NULL,
  betrag       bigint NOT NULL CHECK (betrag > 0 AND betrag <= 1000000000000),
  buchung_id   uuid NOT NULL,
  erstellt_am  timestamptz NOT NULL,
  UNIQUE (kunde_id, id),
  UNIQUE (kunde_id, buchung_id),
  FOREIGN KEY (kunde_id, buchung_id) REFERENCES buchhaltung_buchung (kunde_id, id)
);
CREATE INDEX guthaben_person_idx ON buchhaltung_guthaben (kunde_id, person_id);

CREATE TABLE buchhaltung_zuordnung (
  lfd            bigint GENERATED ALWAYS AS IDENTITY,
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  guthaben_id    uuid NOT NULL,
  posten_id      uuid NOT NULL,
  -- Negativ = Aufhebung einer früheren Zuordnung.
  betrag         bigint NOT NULL CHECK (betrag <> 0 AND abs(betrag) <= 1000000000000),
  aufhebung_von  uuid,
  erstellt_am    timestamptz NOT NULL,
  erstellt_von   text NOT NULL CHECK (length(erstellt_von) BETWEEN 1 AND 100),
  UNIQUE (kunde_id, id),
  -- Höchstens eine Aufhebung je Zuordnung.
  UNIQUE (kunde_id, aufhebung_von),
  FOREIGN KEY (kunde_id, guthaben_id) REFERENCES buchhaltung_guthaben (kunde_id, id),
  FOREIGN KEY (kunde_id, posten_id) REFERENCES buchhaltung_offener_posten (kunde_id, id),
  FOREIGN KEY (kunde_id, aufhebung_von) REFERENCES buchhaltung_zuordnung (kunde_id, id),
  CHECK ((betrag < 0) = (aufhebung_von IS NOT NULL))
);
CREATE INDEX zuordnung_guthaben_idx ON buchhaltung_zuordnung (kunde_id, guthaben_id);
CREATE INDEX zuordnung_posten_idx ON buchhaltung_zuordnung (kunde_id, posten_id);

-- Zuordnungen bleiben je Guthaben und je Posten zwischen 0 und dem Betrag, nur für dieselbe Person,
-- nie auf stornierte Belege. Die Sperre je Kunde serialisiert parallele Zuordnungen.
CREATE FUNCTION buchhaltung_zuordnung_pruefen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  g public.buchhaltung_guthaben;
  p public.buchhaltung_offener_posten;
  summe_guthaben bigint;
  summe_posten bigint;
BEGIN
  PERFORM buchhaltung_sperre(new.kunde_id);

  SELECT * INTO g FROM public.buchhaltung_guthaben WHERE id = new.guthaben_id AND kunde_id = new.kunde_id;
  SELECT * INTO p FROM public.buchhaltung_offener_posten WHERE id = new.posten_id AND kunde_id = new.kunde_id;
  IF g.id IS NULL OR p.id IS NULL THEN
    RAISE EXCEPTION 'Guthaben oder Posten gehört nicht zum Kunden' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF g.person_id <> p.person_id THEN
    RAISE EXCEPTION 'Guthaben und Posten gehören zu verschiedenen Personen' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF new.betrag > 0 AND EXISTS (
    SELECT FROM public.buchhaltung_buchung b
    WHERE b.kunde_id = new.kunde_id AND b.storno_von IN (g.buchung_id, p.buchung_id)
  ) THEN
    RAISE EXCEPTION 'Zuordnung auf stornierten Beleg' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coalesce(sum(z.betrag), 0) + new.betrag INTO summe_guthaben
  FROM public.buchhaltung_zuordnung z WHERE z.kunde_id = new.kunde_id AND z.guthaben_id = g.id;
  SELECT coalesce(sum(z.betrag), 0) + new.betrag INTO summe_posten
  FROM public.buchhaltung_zuordnung z WHERE z.kunde_id = new.kunde_id AND z.posten_id = p.id;
  IF summe_guthaben NOT BETWEEN 0 AND g.betrag OR summe_posten NOT BETWEEN 0 AND p.betrag THEN
    RAISE EXCEPTION 'Zuordnung überschreitet Guthaben oder offenen Rest' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN new;
END
$$;

-- Ein Beleg mit aktiver Zuordnung kann nicht storniert werden (zuerst die Zuordnung aufheben).
CREATE FUNCTION buchhaltung_storno_nur_freie_belege() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF new.storno_von IS NOT NULL AND (
    EXISTS (
      SELECT FROM public.buchhaltung_offener_posten p
      WHERE p.kunde_id = new.kunde_id AND p.buchung_id = new.storno_von
        AND (SELECT coalesce(sum(z.betrag), 0) FROM public.buchhaltung_zuordnung z
             WHERE z.kunde_id = p.kunde_id AND z.posten_id = p.id) <> 0)
    OR EXISTS (
      SELECT FROM public.buchhaltung_guthaben g
      WHERE g.kunde_id = new.kunde_id AND g.buchung_id = new.storno_von
        AND (SELECT coalesce(sum(z.betrag), 0) FROM public.buchhaltung_zuordnung z
             WHERE z.kunde_id = g.kunde_id AND z.guthaben_id = g.id) <> 0)
  ) THEN
    RAISE EXCEPTION 'Beleg hat aktive Zuordnungen; zuerst aufheben' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN new;
END
$$;

CREATE TRIGGER zuordnung_pruefen BEFORE INSERT ON buchhaltung_zuordnung
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_zuordnung_pruefen();
CREATE TRIGGER buchung_b_storno_nur_freie_belege BEFORE INSERT ON buchhaltung_buchung
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_storno_nur_freie_belege();

CREATE TRIGGER offener_posten_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_offener_posten
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER guthaben_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_guthaben
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER zuordnung_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_zuordnung
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER offener_posten_kein_truncate BEFORE TRUNCATE ON buchhaltung_offener_posten
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER guthaben_kein_truncate BEFORE TRUNCATE ON buchhaltung_guthaben
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER zuordnung_kein_truncate BEFORE TRUNCATE ON buchhaltung_zuordnung
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();

ALTER TABLE buchhaltung_offener_posten ENABLE ROW LEVEL SECURITY;
ALTER TABLE buchhaltung_guthaben ENABLE ROW LEVEL SECURITY;
ALTER TABLE buchhaltung_zuordnung ENABLE ROW LEVEL SECURITY;

CREATE POLICY offener_posten_lesen ON buchhaltung_offener_posten
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY offener_posten_anhaengen ON buchhaltung_offener_posten
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY guthaben_lesen ON buchhaltung_guthaben
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY guthaben_anhaengen ON buchhaltung_guthaben
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY zuordnung_lesen ON buchhaltung_zuordnung
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY zuordnung_anhaengen ON buchhaltung_zuordnung
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON buchhaltung_offener_posten, buchhaltung_guthaben, buchhaltung_zuordnung TO stammbuch_app;
