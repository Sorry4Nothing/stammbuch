-- Kontenplan je Kunde. Konten werden nie gelöscht; nur Name und aktiv sind änderbar.

CREATE TABLE buchhaltung_konto (
  kunde_id uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  nummer   text NOT NULL CHECK (nummer ~ '^[0-9]{4,6}$'),
  name     text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  art      text NOT NULL CHECK (art IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  aktiv    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (kunde_id, nummer)
);

CREATE FUNCTION buchhaltung_konto_schutz() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'Konten werden nie gelöscht, nur deaktiviert' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF new.kunde_id <> old.kunde_id OR new.nummer <> old.nummer OR new.art <> old.art THEN
    RAISE EXCEPTION 'Kontonummer und Kontoart sind unveränderlich' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN new;
END
$$;

CREATE TRIGGER konto_schutz BEFORE UPDATE OR DELETE ON buchhaltung_konto
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_konto_schutz();
CREATE TRIGGER konto_kein_truncate BEFORE TRUNCATE ON buchhaltung_konto
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();

ALTER TABLE buchhaltung_konto ENABLE ROW LEVEL SECURITY;

CREATE POLICY konto_eigener_kunde ON buchhaltung_konto
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON buchhaltung_konto TO stammbuch_app;
GRANT UPDATE (name, aktiv) ON buchhaltung_konto TO stammbuch_app;
