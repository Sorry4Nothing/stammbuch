-- Firmenregister mit Freigabestatus. Fremdschlüssel sind zusammengesetzt (kunde_id, id):
-- Fremdschlüsselprüfungen laufen an RLS vorbei und würden sonst Verweise über Mandanten erlauben.

CREATE TABLE firma (
  kunde_id             uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  id                   uuid        NOT NULL DEFAULT uuidv7(),
  name                 text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  uid                  text        CHECK (uid ~ '^CHE-[0-9]{3}\.[0-9]{3}\.[0-9]{3}$'),
  mwst_nr              text        CHECK (mwst_nr ~ '^CHE-[0-9]{3}\.[0-9]{3}\.[0-9]{3} MWST$'),
  strasse              text        NOT NULL CHECK (length(strasse) BETWEEN 1 AND 100),
  hausnr               text        CHECK (length(hausnr) BETWEEN 1 AND 15),
  zusatz               text        CHECK (length(zusatz) BETWEEN 1 AND 100),
  plz                  text        NOT NULL CHECK (length(plz) BETWEEN 2 AND 10),
  ort                  text        NOT NULL CHECK (length(ort) BETWEEN 1 AND 60),
  land                 text        NOT NULL DEFAULT 'CH' CHECK (land ~ '^[A-Z]{2}$'),
  email                text        CHECK (email = lower(email) AND length(email) <= 254),
  telefon              text        CHECK (telefon ~ '^\+[1-9][0-9]{7,14}$'),
  status               text        NOT NULL
                       CHECK (status IN ('ausstehend', 'freigegeben', 'abgelehnt', 'zusammengefuehrt')),
  zusammengefuehrt_mit uuid,
  erstellt_am          timestamptz NOT NULL DEFAULT now(),
  -- Sortier- und Suchtext, von der Datenbank gepflegt.
  name_sort            text COLLATE "C" GENERATED ALWAYS AS (suchtext_normalisieren(name)) STORED,
  suchtext             text GENERATED ALWAYS AS (
                         suchtext_normalisieren(name || ' ' || coalesce(uid, '') || ' ' || ort)
                       ) STORED,
  PRIMARY KEY (kunde_id, id),
  FOREIGN KEY (kunde_id, zusammengefuehrt_mit) REFERENCES firma (kunde_id, id),
  CHECK ((status = 'zusammengefuehrt') = (zusammengefuehrt_mit IS NOT NULL))
);

-- Dieselbe UID nur einmal unter den noch gültigen Firmen (Duplikat beim Anlegen = 409).
CREATE UNIQUE INDEX firma_uid_gueltig ON firma (kunde_id, uid)
  WHERE uid IS NOT NULL AND status IN ('ausstehend', 'freigegeben');
CREATE INDEX firma_sortierung ON firma (kunde_id, name_sort, id);
CREATE INDEX firma_suche ON firma USING gin (suchtext gin_trgm_ops);

ALTER TABLE firma ENABLE ROW LEVEL SECURITY;

CREATE POLICY firma_eigener_kunde ON firma
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Firmen werden nie gelöscht, nur zusammengeführt oder abgelehnt.
GRANT SELECT, INSERT, UPDATE ON firma TO stammbuch_app;
