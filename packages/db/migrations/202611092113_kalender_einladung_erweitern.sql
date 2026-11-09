-- Kalender: Adressliste am Event, Mitglied an der Einladung, neues Token beim erneuten Versand (Issue #113).

-- 1. «Einladung an»: die Gruppe (Adressliste), an die der Event gerichtet ist. Wird die Gruppe aufgelöst,
--    bleibt der Event bestehen und das Feld wird leer. Der zusammengesetzte Fremdschlüssel hält die Gruppe im selben Kunden.
ALTER TABLE kalender_event
  ADD COLUMN einladung_gruppe_id uuid,
  ADD FOREIGN KEY (kunde_id, einladung_gruppe_id) REFERENCES gruppe (kunde_id, id) ON DELETE SET NULL (einladung_gruppe_id);

-- 2. Mitglied, an das die Einladung ging (Gruppe in der Teilnehmerliste). Optional: Einladungen an freie Adressen haben keines.
ALTER TABLE kalender_einladung
  ADD COLUMN mitglied_id uuid,
  ADD FOREIGN KEY (kunde_id, mitglied_id) REFERENCES mitglied (kunde_id, id) ON DELETE SET NULL (mitglied_id);

-- 3. Antwortlinks erneut senden: Gespeichert ist nur der Hash, das alte Token ist nicht rekonstruierbar. Der erneute
--    Versand ersetzt den Hash durch den eines neuen Tokens (der alte Link wird ungültig). Sonst bleibt die Einladung unveränderlich.
GRANT UPDATE (token_hash) ON kalender_einladung TO stammbuch_app;
