-- Anmeldung mit Pflicht-2FA (Issue #4): Rolle und TOTP-Daten am Benutzer.
-- Enrollment-Status: totp_eingerichtet_am IS NOT NULL. Ohne Geheimnis kann es keinen Zähler geben (und umgekehrt).

ALTER TABLE benutzer
  ADD COLUMN rolle text NOT NULL DEFAULT 'user' CHECK (rolle IN ('user', 'chief_admin')),
  -- AES-256-GCM-Geheimtext (Format v1.<iv>.<tag>.<ct>), nie das Klartext-Geheimnis (SR-03).
  ADD COLUMN totp_secret_enc text,
  -- Letzter akzeptierter TOTP-Zeitschritt: Replay-Schutz (derselbe Code gilt nur einmal).
  ADD COLUMN totp_letzter_zaehler bigint,
  ADD COLUMN totp_eingerichtet_am timestamptz,
  ADD CONSTRAINT benutzer_totp_konsistent CHECK (
    (totp_secret_enc IS NULL) = (totp_letzter_zaehler IS NULL)
    AND (totp_secret_enc IS NULL) = (totp_eingerichtet_am IS NULL)
  );

-- Spaltenrechte statt Tabellenrechte: Die Anwendung darf weder die Rolle noch den Mandanten
-- eines Benutzers setzen. chief_admin vergibt nur der Eigentümer (Verwaltungswerkzeug).
-- Die Spalte aktiv ändert der Eigentümer bzw. ein späteres Benutzermodul (eigene Migration).
REVOKE INSERT, UPDATE ON benutzer FROM stammbuch_app;
GRANT INSERT (id, kunde_id, email, name, passwort_hash, aktiv) ON benutzer TO stammbuch_app;
GRANT UPDATE (name, passwort_hash, totp_secret_enc, totp_letzter_zaehler, totp_eingerichtet_am)
  ON benutzer TO stammbuch_app;
