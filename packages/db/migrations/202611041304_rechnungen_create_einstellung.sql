-- Rechnungseinstellungen und Feature-Flags je Kunde (eine Zeile pro Kunde).

CREATE TABLE rechnung_einstellung (
  kunde_id           uuid PRIMARY KEY REFERENCES kunde (id) ON DELETE CASCADE,
  -- Rechnungssteller (Adresse nach QR-Rechnung).
  empfaenger         jsonb NOT NULL,
  iban               text NOT NULL CHECK (length(iban) BETWEEN 15 AND 34),
  mwst_nummer        text CHECK (length(mwst_nummer) <= 40),
  kontakt_zeilen     jsonb NOT NULL DEFAULT '[]'::jsonb,
  nummer_praefix     text NOT NULL CHECK (nummer_praefix ~ '^[A-Z]{1,6}$'),
  gutschrift_praefix text NOT NULL CHECK (gutschrift_praefix ~ '^[A-Z]{1,6}$'),
  -- Ziffern, vorangestellt in der Zahlungsreferenz.
  referenz_praefix   text NOT NULL CHECK (referenz_praefix ~ '^[0-9]{0,10}$'),
  zahlungsfrist_tage integer NOT NULL CHECK (zahlungsfrist_tage BETWEEN 0 AND 365),
  mwst_modus         text NOT NULL CHECK (mwst_modus IN ('ohne', 'exklusiv')),
  mwst_satz_bp       integer NOT NULL CHECK (mwst_satz_bp BETWEEN 0 AND 2500),
  runden_5           boolean NOT NULL,
  mahnstufen         jsonb NOT NULL,
  -- Feature-Flags (Module, die der Betrieb pro Kunde freischaltet).
  sammelrechnung     boolean NOT NULL DEFAULT false,
  geaendert_am       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rechnung_einstellung ENABLE ROW LEVEL SECURITY;

CREATE POLICY rechnung_einstellung_eigener_kunde ON rechnung_einstellung FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE ON rechnung_einstellung TO stammbuch_app;
