-- Kunden (Mandanten). Jede andere Tabelle trägt kunde_id (Projektplan Abschnitt 7).
-- Kunden anlegen und löschen darf nur der Eigentümer (Verwaltung/Chef-Admin-Werkzeug), nicht die Anwendungsrolle.

CREATE TABLE kunde (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  erstellt_am timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kunde ENABLE ROW LEVEL SECURITY;

CREATE POLICY kunde_eigene_zeile ON kunde
  FOR ALL TO stammbuch_app
  USING (id = (SELECT app_kunde_id()))
  WITH CHECK (id = (SELECT app_kunde_id()));

GRANT SELECT ON kunde TO stammbuch_app;
GRANT UPDATE (name) ON kunde TO stammbuch_app;
