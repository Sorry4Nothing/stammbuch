-- Protokoll der Buchhaltung (nur anhängend) und Idempotenzschlüssel.
-- details enthält nur IDs und Beträge, nie Freitexte oder Personendaten (SR-50).

CREATE TABLE buchhaltung_protokoll (
  lfd         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id          uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  kunde_id    uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  zeitpunkt   timestamptz NOT NULL,
  akteur      text NOT NULL CHECK (length(akteur) BETWEEN 1 AND 100),
  aktion      text NOT NULL CHECK (length(aktion) BETWEEN 1 AND 100),
  objekt_typ  text NOT NULL CHECK (length(objekt_typ) BETWEEN 1 AND 100),
  objekt_id   text NOT NULL CHECK (length(objekt_id) BETWEEN 1 AND 100),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX protokoll_kunde_idx ON buchhaltung_protokoll (kunde_id, lfd);

-- Gleicher Schlüssel + gleiche Anfrage = gleiches Ergebnis (anfrage_hash), gleicher Schlüssel + andere Anfrage = Konflikt.
CREATE TABLE buchhaltung_idempotenz (
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  schluessel    text NOT NULL CHECK (schluessel ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  anfrage_hash  text NOT NULL CHECK (anfrage_hash ~ '^[0-9a-f]{64}$'),
  ergebnis      jsonb NOT NULL,
  erstellt_am   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, schluessel)
);

CREATE TRIGGER protokoll_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_protokoll
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER idempotenz_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_idempotenz
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER protokoll_kein_truncate BEFORE TRUNCATE ON buchhaltung_protokoll
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER idempotenz_kein_truncate BEFORE TRUNCATE ON buchhaltung_idempotenz
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();

ALTER TABLE buchhaltung_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE buchhaltung_idempotenz ENABLE ROW LEVEL SECURITY;

CREATE POLICY protokoll_lesen ON buchhaltung_protokoll
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY protokoll_anhaengen ON buchhaltung_protokoll
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY idempotenz_lesen ON buchhaltung_idempotenz
  FOR SELECT TO stammbuch_app USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY idempotenz_anhaengen ON buchhaltung_idempotenz
  FOR INSERT TO stammbuch_app WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON buchhaltung_protokoll, buchhaltung_idempotenz TO stammbuch_app;
