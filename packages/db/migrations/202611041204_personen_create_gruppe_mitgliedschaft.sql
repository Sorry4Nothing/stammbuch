-- Höchstens eine Gruppe pro Person: PRIMARY KEY (kunde_id, mitglied_id) ohne gruppe_id.
-- Eine zweite Zeile für dasselbe Mitglied scheitert in der Datenbank, egal welcher Code schreibt.

CREATE TABLE gruppe_mitgliedschaft (
  kunde_id    uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  mitglied_id uuid NOT NULL,
  gruppe_id   uuid NOT NULL,
  PRIMARY KEY (kunde_id, mitglied_id),
  FOREIGN KEY (kunde_id, mitglied_id) REFERENCES mitglied (kunde_id, id) ON DELETE CASCADE,
  FOREIGN KEY (kunde_id, gruppe_id) REFERENCES gruppe (kunde_id, id) ON DELETE CASCADE
);

CREATE INDEX gruppe_mitgliedschaft_gruppe ON gruppe_mitgliedschaft (kunde_id, gruppe_id);

ALTER TABLE gruppe_mitgliedschaft ENABLE ROW LEVEL SECURITY;

CREATE POLICY gruppe_mitgliedschaft_eigener_kunde ON gruppe_mitgliedschaft
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Entfernen aus der Gruppe löscht die Zeile; beim Auflösen einer Gruppe räumt CASCADE auf.
GRANT SELECT, INSERT, DELETE ON gruppe_mitgliedschaft TO stammbuch_app;
