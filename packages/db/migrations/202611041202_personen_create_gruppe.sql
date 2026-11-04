-- Gruppen eines Kunden. Der Name ist je Kunde eindeutig, ohne Beachtung von Gross-/Kleinschreibung
-- und Akzenten (gleiche Vergleichsform wie die Suche).

CREATE TABLE gruppe (
  kunde_id uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  id       uuid NOT NULL DEFAULT uuidv7(),
  name     text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (kunde_id, id)
);

CREATE UNIQUE INDEX gruppe_name_key ON gruppe (kunde_id, suchtext_normalisieren(name));

ALTER TABLE gruppe ENABLE ROW LEVEL SECURITY;

CREATE POLICY gruppe_eigener_kunde ON gruppe
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON gruppe TO stammbuch_app;
