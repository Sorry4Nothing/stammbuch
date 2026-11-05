-- Audit-Log für sicherheits- und buchhaltungsrelevante Aktionen (SR-52). Nur anhängen:
-- die Anwendungsrolle hat weder UPDATE noch DELETE. Nie Geheimnisse oder Klartext-Personendaten in details (SR-50).
-- Löschen geschieht nur mit dem Kunden (ON DELETE CASCADE, Vertragsende) durch den Eigentümer.

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kunde_id    uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id uuid,
  zeitpunkt   timestamptz NOT NULL DEFAULT now(),
  aktion      text NOT NULL CHECK (length(aktion) BETWEEN 1 AND 100),
  objekt_typ  text CHECK (length(objekt_typ) <= 100),
  objekt_id   text CHECK (length(objekt_id) <= 100),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bei gesetztem benutzer_id muss der Benutzer zum selben Kunden gehören.
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX audit_log_kunde_zeitpunkt_idx ON audit_log (kunde_id, zeitpunkt DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_lesen ON audit_log
  FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));

CREATE POLICY audit_log_anhaengen ON audit_log
  FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON audit_log TO stammbuch_app;
