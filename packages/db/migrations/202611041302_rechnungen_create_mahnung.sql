-- Mahnungen: pro Rechnung und Stufe genau eine, unveränderlich (nur anhängend). Die Gebühr gilt für die Mahnung.

CREATE TABLE mahnung (
  id             uuid PRIMARY KEY,
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  rechnung_id    uuid NOT NULL,
  stufe          integer NOT NULL CHECK (stufe BETWEEN 1 AND 10),
  titel          text NOT NULL CHECK (length(titel) BETWEEN 1 AND 60),
  ausgestellt_am date NOT NULL,
  faellig_am     date NOT NULL,
  gebuehr_rappen bigint NOT NULL CHECK (gebuehr_rappen >= 0),
  -- Offener Rechnungsbetrag zum Zeitpunkt der Mahnung.
  offen_rappen   bigint NOT NULL,
  -- Zu zahlen: offener Betrag plus alle Gebühren bis einschliesslich dieser Stufe.
  total_rappen   bigint NOT NULL,
  erstellt_am    timestamptz NOT NULL,
  UNIQUE (rechnung_id, stufe),
  FOREIGN KEY (rechnung_id, kunde_id) REFERENCES rechnung (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX mahnung_kunde_idx ON mahnung (kunde_id);

CREATE TRIGGER mahnung_nur_anhaengen
  BEFORE UPDATE OR DELETE ON mahnung
  FOR EACH ROW EXECUTE FUNCTION nur_anhaengen();

ALTER TABLE mahnung ENABLE ROW LEVEL SECURITY;

CREATE POLICY mahnung_lesen ON mahnung FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY mahnung_anhaengen ON mahnung FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON mahnung TO stammbuch_app;
