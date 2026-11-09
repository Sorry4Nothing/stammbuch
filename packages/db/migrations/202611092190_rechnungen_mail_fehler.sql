-- Zustellfehler der Rechnungsmail (#190). mail_fehler_am: Zeitpunkt des letzten fehlgeschlagenen Mailversands einer gebuchten
-- Rechnung; NULL = kein offener Zustellfehler. Die API setzt die Spalte, wenn die Mail nicht in die Versandwarteschlange kam,
-- und löscht sie beim nächsten erfolgreichen Senden. Nur additiv.
-- Zeilensicherheit und Rechte gelten tabellenweit und decken die neue Spalte ab (Mandantentrennung über kunde_id).
-- Der Schutz gebuchter Belege bleibt unverändert, nur mail_fehler_am zählt nicht zu den gesperrten Feldern: ein Mailstatus
-- ist kein Inhalt des Belegs. Die Versionsregel (+1 je Änderung) gilt weiter.

ALTER TABLE rechnung
  ADD COLUMN mail_fehler_am timestamptz;

CREATE OR REPLACE FUNCTION rechnung_schuetzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'entwurf' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'Versendete Belege werden nie gelöscht' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'entwurf' THEN
    IF NEW.status = 'entwurf' THEN
      RAISE EXCEPTION 'Ein versendeter Beleg wird nicht zum Entwurf' USING ERRCODE = 'restrict_violation';
    END IF;
    -- "jahr" ist berechnet und in NEW noch nicht gesetzt: ausnehmen (folgt aus rechnungsdatum, das geschützt ist).
    IF to_jsonb(OLD) - 'status' - 'version' - 'geaendert_am' - 'jahr' - 'mail_fehler_am' IS DISTINCT FROM to_jsonb(NEW) - 'status' - 'version' - 'geaendert_am' - 'jahr' - 'mail_fehler_am' THEN
      RAISE EXCEPTION 'Versendete Belege sind unveränderlich' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  -- Optimistisches Sperren auch auf Datenbankebene: jede Änderung zählt die Version um genau eins hoch.
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Version muss um 1 steigen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
