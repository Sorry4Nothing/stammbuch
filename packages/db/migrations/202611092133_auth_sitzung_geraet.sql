-- Gerät der Sitzung (Issue #133): kurze, bereinigte Bezeichnung aus dem User-Agent bei der Anmeldung («Firefox auf
-- Windows»). Die API setzt sie aus einer festen Liste von Browser- und Systemnamen; der rohe User-Agent wird nie
-- gespeichert. Additiv: NULL = unbekannt (bestehende Sitzungen, nicht erkennbare Geräte).
--
-- Mandantentrennung: Die Spalte liegt in `sitzung` und fällt unter die bestehende RLS-Richtlinie und das GRANT der
-- Tabelle. Neu ist nur die Rückgabe von chef_sitzungen (Spalte `geraet`); die Funktion prüft den Akteur wie bisher als
-- aktiven `chief_admin` in der Datenbank. Eine andere Rückgabeform verlangt DROP und neu anlegen.

ALTER TABLE sitzung
  ADD COLUMN geraet text CHECK (geraet IS NULL OR (length(geraet) BETWEEN 1 AND 60));

DROP FUNCTION chef_sitzungen(uuid, bytea);

CREATE FUNCTION chef_sitzungen(p_akteur uuid, p_token_hash bytea)
RETURNS TABLE (id uuid, erstellt_am timestamptz, aktuell boolean, geraet text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.erstellt_am, s.token_hash = p_token_hash, s.geraet
  FROM public.sitzung s
  WHERE s.benutzer_id = p_akteur AND s.phase = 'full' AND s.widerrufen_am IS NULL AND s.laeuft_ab_am > now()
    AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY s.erstellt_am DESC, s.id DESC
$$;

REVOKE ALL ON FUNCTION chef_sitzungen(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chef_sitzungen(uuid, bytea) TO stammbuch_app;
