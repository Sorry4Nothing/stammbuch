-- Platform (Issue #39): Vertragsdaten am Kunden, Kundenrolle und Einladungsstatus am Benutzer.
-- Bestehende Zeilen bleiben unverändert nutzbar: Kunden sind aktiv, Benutzer haben die Kundenrolle 'user'.

-- Vertragsdaten. Die Anwendungsrolle darf sie lesen, aber nicht ändern (GRANT UPDATE bleibt auf name):
-- ein Kunde kann seine Lizenz nicht selbst verlängern. Ändern darf sie nur der Chef-Admin über die
-- Funktionen der Migration 202611041802. Ohne Angabe gilt die Lizenz nur bis heute (restriktiv).
ALTER TABLE kunde
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  ADD COLUMN lizenz_gueltig_bis date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN beendet_am timestamptz,
  ADD CONSTRAINT kunde_beendet_konsistent CHECK ((status = 'ended') = (beendet_am IS NOT NULL));

-- Kundenrolle (Admin des Kunden oder normaler Benutzer). Sie ist unabhängig von `rolle` (Anbieter-Rechte):
-- `chief_admin` vergibt weiterhin nur der Eigentümer. Ein Admin des Kunden wirkt nur im eigenen Kunden (RLS).
-- `status = 'invited'`: Benutzer ist angelegt, hat die Einladung aber noch nicht eingelöst. Er ist dann nie aktiv
-- und kann sich nicht anmelden (benutzer_fuer_anmeldung und sitzung_aufloesen prüfen `aktiv`).
ALTER TABLE benutzer
  ADD COLUMN kunden_rolle text NOT NULL DEFAULT 'user' CHECK (kunden_rolle IN ('admin', 'user')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active')),
  ADD CONSTRAINT benutzer_eingeladen_inaktiv CHECK (status = 'active' OR NOT aktiv);

GRANT INSERT (kunden_rolle, status) ON benutzer TO stammbuch_app;
GRANT UPDATE (kunden_rolle) ON benutzer TO stammbuch_app;

-- Wird ein Benutzer entfernt, bleiben seine Protokolleinträge erhalten (SR-52). Bisher löschte CASCADE sie mit.
-- Der Eintrag verliert nur den Verweis auf den Benutzer; Akteur und Ziel stehen zusätzlich in `details`.
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_benutzer_id_kunde_id_fkey,
  ADD FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE SET NULL (benutzer_id);
