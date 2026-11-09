-- Letzte Anmeldung und Datum der letzten Passwortänderung (Issue #114): Anzeige in den Einstellungen (Benutzerliste,
-- «Ihre Anmeldung»). Nur additiv: bestehende Zeilen bleiben NULL («unbekannt»), nichts wird nachträglich erfunden.
-- RLS gilt unverändert (die Policy benutzer_eigener_kunde deckt alle Spalten der Tabelle). Die Anwendung darf beide
-- Spalten setzen, nicht löschen oder anderweitig umbiegen: Spaltenrecht wie bei den TOTP-Spalten.

ALTER TABLE benutzer
  ADD COLUMN letzte_anmeldung_am timestamptz,
  ADD COLUMN passwort_geaendert_am timestamptz;

GRANT UPDATE (letzte_anmeldung_am, passwort_geaendert_am) ON benutzer TO stammbuch_app;
