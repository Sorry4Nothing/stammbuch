-- Mailkonten (SMTP/IMAP) eines Benutzers. Das Passwort steht nur als AES-256-GCM-Chiffretext in der Datenbank
-- (SR-30); der Schlüsselring liegt ausserhalb (MAIL_ENCRYPTION_KEYS).

CREATE TABLE mail_konto (
  -- Vom Dienst vergeben: die ID ist zugleich der Kontext der Verschlüsselung (Chiffretext gilt nur für dieses Konto).
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id         uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id      uuid NOT NULL,
  bezeichnung      text NOT NULL CHECK (length(bezeichnung) <= 80),
  absender_adresse text NOT NULL CHECK (length(absender_adresse) BETWEEN 3 AND 254),
  absender_name    text CHECK (length(absender_name) <= 120),
  benutzername     text NOT NULL CHECK (length(benutzername) BETWEEN 1 AND 254),
  geheimnis_enc    text NOT NULL CHECK (length(geheimnis_enc) BETWEEN 1 AND 4000),
  smtp_host        text NOT NULL CHECK (length(smtp_host) BETWEEN 1 AND 253),
  smtp_port        integer NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_sicherheit  text NOT NULL CHECK (smtp_sicherheit IN ('tls', 'starttls')),
  -- IMAP ist optional: alle drei Spalten gesetzt oder alle leer.
  imap_host        text CHECK (length(imap_host) BETWEEN 1 AND 253),
  imap_port        integer CHECK (imap_port BETWEEN 1 AND 65535),
  imap_sicherheit  text CHECK (imap_sicherheit IN ('tls', 'starttls')),
  erstellt_am      timestamptz NOT NULL DEFAULT now(),
  CHECK ((imap_host IS NULL) = (imap_port IS NULL) AND (imap_host IS NULL) = (imap_sicherheit IS NULL)),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id),
  UNIQUE (id, kunde_id)
);

CREATE INDEX mail_konto_benutzer_idx ON mail_konto (kunde_id, benutzer_id, erstellt_am);

ALTER TABLE mail_konto ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_konto_eigener_kunde ON mail_konto
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein Spaltenrecht auf kunde_id/benutzer_id: ein Konto wechselt weder Mandant noch Eigentümer.
GRANT SELECT, INSERT, DELETE ON mail_konto TO stammbuch_app;
GRANT UPDATE (bezeichnung, absender_adresse, absender_name, benutzername, geheimnis_enc,
              smtp_host, smtp_port, smtp_sicherheit, imap_host, imap_port, imap_sicherheit)
  ON mail_konto TO stammbuch_app;
