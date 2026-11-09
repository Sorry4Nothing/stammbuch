-- Mail-Schnittstellen für die Oberfläche (#112): Beschreibung, Personenverweise und letzte Verwendung der
-- Adresslisten, Listenname und «Bestätigt von» der Versandaufträge, Pausieren und neuer Zeitpunkt.
-- Nur additiv: bestehende Zeilen behalten ihre Werte, die neuen Spalten haben Vorgaben bzw. sind leer.

ALTER TABLE mail_adressliste
  ADD COLUMN beschreibung text NOT NULL DEFAULT '' CHECK (length(beschreibung) <= 500),
  -- Verweise auf Personen des Personenmoduls, wie `gruppen_ids` ohne Fremdschlüssel: unbekannte IDs ergeben keine Empfänger.
  ADD COLUMN personen_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN zuletzt_verwendet_am timestamptz;

GRANT UPDATE (beschreibung, personen_ids, zuletzt_verwendet_am) ON mail_adressliste TO stammbuch_app;

ALTER TABLE mail_kampagne
  -- Stand beim Anlegen bzw. Bestätigen; spätere Umbenennungen ändern den Versandverlauf nicht.
  ADD COLUMN listenname text CHECK (length(listenname) <= 200),
  ADD COLUMN bestaetigt_von text CHECK (length(bestaetigt_von) <= 200);

-- Neuer Zustand «paused»: angehalten, offene Zustellungen liegen auf `held`.
ALTER TABLE mail_kampagne DROP CONSTRAINT mail_kampagne_status_check;
ALTER TABLE mail_kampagne ADD CONSTRAINT mail_kampagne_status_check
  CHECK (status IN ('awaiting_confirmation', 'confirmed', 'paused', 'cancelled'));

-- Zeitpunkt ändern (Kampagne und offene Zustellungen) und Bestätigung vermerken.
GRANT UPDATE (geplant_am, bestaetigt_von) ON mail_kampagne TO stammbuch_app;
GRANT UPDATE (naechster_versuch_am) ON mail_zustellung TO stammbuch_app;

-- Der Worker darf eine übernommene Zustellung auch auf `held` zurücklegen, wenn der Versand inzwischen pausiert wurde.
CREATE OR REPLACE FUNCTION mail_zustellung_abschliessen(
  p_id uuid, p_status text, p_gesendet_am timestamptz, p_nachrichten_id text,
  p_letzter_fehler text, p_naechster_versuch_am timestamptz
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.mail_zustellung z
  SET status = p_status,
      lease_bis = NULL,
      letzter_fehler = p_letzter_fehler,
      gesendet_am = coalesce(p_gesendet_am, z.gesendet_am),
      nachrichten_id = coalesce(p_nachrichten_id, z.nachrichten_id),
      naechster_versuch_am = coalesce(p_naechster_versuch_am, z.naechster_versuch_am)
  WHERE z.id = p_id AND z.status = 'sending' AND p_status IN ('sent', 'queued', 'failed', 'held')
$$;
