-- Beitrag je Gruppe für die Sammelrechnung (#109). Keine Zeile = Gruppe ohne Beitrag.
-- Der Betrag ist der Bruttobetrag pro Person in Rappen; der Lauf legt daraus je Person eine Position an.

CREATE TABLE rechnung_gruppenbeitrag (
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  gruppe_id      uuid NOT NULL,
  beitrag_rappen bigint NOT NULL CHECK (beitrag_rappen BETWEEN 1 AND 100000000),
  geaendert_am   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, gruppe_id),
  -- Zusammengesetzt: ein Verweis auf die Gruppe eines anderen Kunden ist ausgeschlossen.
  FOREIGN KEY (kunde_id, gruppe_id) REFERENCES gruppe (kunde_id, id) ON DELETE CASCADE
);

ALTER TABLE rechnung_gruppenbeitrag ENABLE ROW LEVEL SECURITY;

CREATE POLICY rechnung_gruppenbeitrag_eigener_kunde ON rechnung_gruppenbeitrag FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON rechnung_gruppenbeitrag TO stammbuch_app;
