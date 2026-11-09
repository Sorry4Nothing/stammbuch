-- Personen, Gruppen, Firmen: Felder, die die Oberfläche zeigt (#108). Nur additiv.
-- Spalten mit IF NOT EXISTS: Die Registrierung (#107) ergänzt dieselben Felder
-- (mitglied.geburtsdatum, firma.kontaktperson); wer zuerst läuft, legt sie an.

-- Mitglied: Mitgliedsnummer, Geburtsdatum, Eintritt, bevorzugter Kanal.
ALTER TABLE mitglied
  ADD COLUMN IF NOT EXISTS mitgliedsnr  text,
  ADD COLUMN IF NOT EXISTS geburtsdatum date CHECK (geburtsdatum BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  ADD COLUMN IF NOT EXISTS eintritt     date CHECK (eintritt BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  ADD COLUMN IF NOT EXISTS kanal        text CHECK (kanal IN ('email', 'post'));

-- Nummernkreis je Kunde. Die Nummer vergibt ein Trigger in derselben Transaktion wie das INSERT:
-- kein Rennen zwischen parallelen Anfragen, bei Rollback bleibt keine Lücke.
CREATE TABLE mitglied_nummernkreis (
  kunde_id      uuid    PRIMARY KEY REFERENCES kunde (id) ON DELETE CASCADE,
  letzte_nummer integer NOT NULL CHECK (letzte_nummer >= 1000)
);

ALTER TABLE mitglied_nummernkreis ENABLE ROW LEVEL SECURITY;

CREATE POLICY mitglied_nummernkreis_eigener_kunde ON mitglied_nummernkreis
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE ON mitglied_nummernkreis TO stammbuch_app;

-- Bestehende Mitglieder nummerieren (nach Erfassung) und den Nummernkreis nachziehen.
UPDATE mitglied m
   SET mitgliedsnr = 'M-' || n.nr
  FROM (
    SELECT kunde_id, id, 1000 + row_number() OVER (PARTITION BY kunde_id ORDER BY erstellt_am, id) AS nr
      FROM mitglied
  ) n
 WHERE m.kunde_id = n.kunde_id AND m.id = n.id AND m.mitgliedsnr IS NULL;

INSERT INTO mitglied_nummernkreis (kunde_id, letzte_nummer)
SELECT kunde_id, 1000 + count(*) FROM mitglied GROUP BY kunde_id
ON CONFLICT (kunde_id) DO NOTHING;

ALTER TABLE mitglied ALTER COLUMN mitgliedsnr SET NOT NULL;
CREATE UNIQUE INDEX mitglied_mitgliedsnr_key ON mitglied (kunde_id, mitgliedsnr);

CREATE FUNCTION mitglied_nummer_setzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  nr integer;
BEGIN
  -- Eine mitgegebene Nummer wird ignoriert: Nummern vergibt nur die Datenbank.
  INSERT INTO mitglied_nummernkreis AS k (kunde_id, letzte_nummer) VALUES (NEW.kunde_id, 1001)
    ON CONFLICT (kunde_id) DO UPDATE SET letzte_nummer = k.letzte_nummer + 1
    RETURNING letzte_nummer INTO nr;
  NEW.mitgliedsnr := 'M-' || nr;
  RETURN NEW;
END
$$;

CREATE TRIGGER mitglied_nummer BEFORE INSERT ON mitglied
  FOR EACH ROW EXECUTE FUNCTION mitglied_nummer_setzen();

-- Die Nummer ändert sich nie.
CREATE FUNCTION mitglied_nummer_festhalten() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.mitgliedsnr := OLD.mitgliedsnr;
  RETURN NEW;
END
$$;

CREATE TRIGGER mitglied_nummer_fest BEFORE UPDATE ON mitglied
  FOR EACH ROW EXECUTE FUNCTION mitglied_nummer_festhalten();

-- Gruppe: Beschreibung, angelegt, zuletzt geändert; Mitgliedschaft: seit wann.
ALTER TABLE gruppe
  ADD COLUMN IF NOT EXISTS beschreibung text CHECK (length(beschreibung) BETWEEN 1 AND 300),
  ADD COLUMN IF NOT EXISTS erstellt_am  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS geaendert_am timestamptz NOT NULL DEFAULT now();

ALTER TABLE gruppe_mitgliedschaft
  ADD COLUMN IF NOT EXISTS seit timestamptz NOT NULL DEFAULT now();

-- Firma: Kontaktperson, Rechnungs-E-Mail, Bemerkung, Quelle der Erfassung.
-- Bestehende Firmen gelten als manuell erfasst: die Herkunft früherer Selbstregistrierungen ist nicht gespeichert.
ALTER TABLE firma
  ADD COLUMN IF NOT EXISTS kontaktperson   text CHECK (length(kontaktperson) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS rechnungs_email text CHECK (rechnungs_email = lower(rechnungs_email) AND length(rechnungs_email) <= 254),
  ADD COLUMN IF NOT EXISTS notiz           text CHECK (length(notiz) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS quelle          text NOT NULL DEFAULT 'manuell' CHECK (quelle IN ('manuell', 'selbst'));

-- Firmenpaare, die als «kein Duplikat» bestätigt wurden. Fremdschlüssel zusammengesetzt (kunde_id, id).
CREATE TABLE firma_duplikat_ausnahme (
  kunde_id    uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  firma_a     uuid        NOT NULL,
  firma_b     uuid        NOT NULL,
  erstellt_am timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, firma_a, firma_b),
  FOREIGN KEY (kunde_id, firma_a) REFERENCES firma (kunde_id, id),
  FOREIGN KEY (kunde_id, firma_b) REFERENCES firma (kunde_id, id),
  CHECK (firma_a < firma_b)
);

ALTER TABLE firma_duplikat_ausnahme ENABLE ROW LEVEL SECURITY;

CREATE POLICY firma_duplikat_ausnahme_eigener_kunde ON firma_duplikat_ausnahme
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON firma_duplikat_ausnahme TO stammbuch_app;
