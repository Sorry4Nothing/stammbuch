-- Aufgaben eines Kunden (Startseite, Navigationszähler). Eine Aufgabe ist offen, bis `erledigt_am` gesetzt ist.

CREATE TABLE aufgabe (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  titel         text NOT NULL CHECK (length(titel) BETWEEN 1 AND 200),
  faellig_am    date NOT NULL,
  erledigt_am   timestamptz,
  erstellt_von  uuid NOT NULL,
  erstellt_am   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (erstellt_von, kunde_id) REFERENCES benutzer (id, kunde_id)
);

-- Offene Aufgaben nach Fälligkeit (Startseite): Teilindex, erledigte fallen heraus.
CREATE INDEX aufgabe_offen_idx ON aufgabe (kunde_id, faellig_am) WHERE erledigt_am IS NULL;

ALTER TABLE aufgabe ENABLE ROW LEVEL SECURITY;

CREATE POLICY aufgabe_eigener_kunde ON aufgabe
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein DELETE: Aufgaben werden erledigt, nicht gelöscht. UPDATE nur auf die Erledigung.
GRANT SELECT, INSERT ON aufgabe TO stammbuch_app;
GRANT UPDATE (erledigt_am) ON aufgabe TO stammbuch_app;
