-- Sitzungen mit Zwischenstufe: nach dem Passwort ist die Sitzung "pending" (nur zweiter Faktor erlaubt),
-- erst nach TOTP oder Wiederherstellungscode "full". Fehlversuche des zweiten Faktors zählen pro Sitzung.

ALTER TABLE sitzung
  ADD COLUMN phase text NOT NULL DEFAULT 'full' CHECK (phase IN ('pending', 'full')),
  -- Bestehende Zeilen bekommen ein nie ausgeliefertes Token; neue Sitzungen setzen es immer selbst.
  ADD COLUMN csrf_token text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN zuletzt_gesehen_am timestamptz NOT NULL DEFAULT now(),
  -- Noch nicht bestätigtes TOTP-Geheimnis während der Einrichtung (verschlüsselt).
  ADD COLUMN totp_pending_enc text,
  ADD COLUMN mfa_fehlversuche integer NOT NULL DEFAULT 0 CHECK (mfa_fehlversuche >= 0);

ALTER TABLE sitzung ALTER COLUMN phase DROP DEFAULT, ALTER COLUMN csrf_token DROP DEFAULT;
