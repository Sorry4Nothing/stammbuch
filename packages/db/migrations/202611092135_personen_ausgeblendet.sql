-- Personen: Freigabe selbst registrierter Personen, Duplikate und Zusammenführen, Verlauf; Firmen: erfasst von (#135).
-- Nur additiv. Neue Tabellen mit RLS und `kunde_id`, Verweise auf Mitglieder zusammengesetzt (kunde_id, id).

-- 1. Mitglied: Status «ausstehend» (selbst registriert, wartet auf Freigabe), «abgelehnt» und «zusammengefuehrt»
--    (in eine andere Person aufgegangen, bleibt als Verweis für Rechnungen und Buchungen bestehen).
ALTER TABLE mitglied DROP CONSTRAINT mitglied_status_check;
ALTER TABLE mitglied ADD CONSTRAINT mitglied_status_check
  CHECK (status IN ('aktiv', 'archiviert', 'ausstehend', 'abgelehnt', 'zusammengefuehrt'));

-- Herkunft des Eintrags. Bestehende Mitglieder gelten als manuell erfasst (die Herkunft früherer Selbstregistrierungen ist nicht gespeichert).
ALTER TABLE mitglied
  ADD COLUMN quelle              text NOT NULL DEFAULT 'manuell' CHECK (quelle IN ('manuell', 'selbst')),
  ADD COLUMN zusammengefuehrt_mit uuid;

ALTER TABLE mitglied
  ADD FOREIGN KEY (kunde_id, zusammengefuehrt_mit) REFERENCES mitglied (kunde_id, id),
  ADD CHECK ((status = 'zusammengefuehrt') = (zusammengefuehrt_mit IS NOT NULL));

CREATE INDEX mitglied_zusammengefuehrt ON mitglied (kunde_id, zusammengefuehrt_mit) WHERE zusammengefuehrt_mit IS NOT NULL;

-- 2. Personenpaare, die als «kein Duplikat» bestätigt wurden.
CREATE TABLE mitglied_duplikat_ausnahme (
  kunde_id    uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  mitglied_a  uuid        NOT NULL,
  mitglied_b  uuid        NOT NULL,
  erstellt_am timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, mitglied_a, mitglied_b),
  FOREIGN KEY (kunde_id, mitglied_a) REFERENCES mitglied (kunde_id, id),
  FOREIGN KEY (kunde_id, mitglied_b) REFERENCES mitglied (kunde_id, id),
  CHECK (mitglied_a < mitglied_b)
);

ALTER TABLE mitglied_duplikat_ausnahme ENABLE ROW LEVEL SECURITY;

CREATE POLICY mitglied_duplikat_ausnahme_eigener_kunde ON mitglied_duplikat_ausnahme
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON mitglied_duplikat_ausnahme TO stammbuch_app;

-- 3. Verlauf einer Person: Gruppenwechsel und Entscheide, die sich aus den Stammdaten nicht ablesen lassen.
--    Nur anhängend. Der Gruppenname steht als Text hier, weil die Gruppe später aufgelöst werden kann.
CREATE TABLE mitglied_ereignis (
  kunde_id    uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  id          uuid        NOT NULL DEFAULT uuidv7(),
  mitglied_id uuid        NOT NULL,
  art         text        NOT NULL CHECK (art IN ('gruppe_zugewiesen', 'gruppe_entfernt', 'freigegeben', 'abgelehnt', 'zusammengefuehrt')),
  detail      text        CHECK (length(detail) BETWEEN 1 AND 200),
  erstellt_am timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, id),
  FOREIGN KEY (kunde_id, mitglied_id) REFERENCES mitglied (kunde_id, id)
);

CREATE INDEX mitglied_ereignis_mitglied ON mitglied_ereignis (kunde_id, mitglied_id, erstellt_am);

ALTER TABLE mitglied_ereignis ENABLE ROW LEVEL SECURITY;

CREATE POLICY mitglied_ereignis_eigener_kunde ON mitglied_ereignis
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON mitglied_ereignis TO stammbuch_app;

-- 4. Firma: erfasst von (Benutzer, der den Eintrag angelegt hat). Selbstregistrierungen haben keinen. Wird der Benutzer gelöscht, bleibt die Firma.
ALTER TABLE firma
  ADD COLUMN erfasst_von uuid,
  ADD FOREIGN KEY (erfasst_von, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE SET NULL (erfasst_von);

-- 5. Zusammenführen: Einladungen der aufgegangenen Person zeigen danach auf die behaltene (die Antworten hängen an der Einladung).
--    Spaltenrecht nur für mitglied_id; Name, Adresse und Token bleiben unveränderlich.
GRANT UPDATE (mitglied_id) ON kalender_einladung TO stammbuch_app;
