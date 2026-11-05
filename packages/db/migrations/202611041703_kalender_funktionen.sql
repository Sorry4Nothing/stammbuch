-- Wege an RLS vorbei für den Kalender, jeweils schmal und mit festen Spalten (SECURITY DEFINER, Eigentümer).

-- 1. Öffentliche Antwortroute: das Token führt erst zum Mandanten. Höchstens eine Zeile.
CREATE FUNCTION kalender_einladung_aufloesen(p_token_hash bytea)
RETURNS TABLE (id uuid, kunde_id uuid, event_id uuid, email text, name text, erstellt_am timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.kunde_id, e.event_id, e.email, e.name, e.erstellt_am
  FROM public.kalender_einladung e
  WHERE e.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION kalender_einladung_aufloesen(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kalender_einladung_aufloesen(bytea) TO stammbuch_app;

-- 2. Lösch-Job (Worker): mandantenübergreifend, aber nur diese zwei Funktionen und nur diese drei Tabellen.
-- Eigene Rolle: Die API (stammbuch_app) kann weder fremde Events auflisten noch löschen.
-- Anmelden darf die Rolle erst, wenn der Betrieb ein Passwort setzt (CLI: WORKER_DB_PASSWORD).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stammbuch_worker') THEN
    CREATE ROLE stammbuch_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'stammbuch_worker' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'Rolle stammbuch_worker hat Sonderrechte (SUPERUSER, BYPASSRLS, CREATEROLE oder CREATEDB)';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO stammbuch_worker;

CREATE FUNCTION kalender_abgelaufene_events(p_cutoff timestamptz)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id FROM public.kalender_event e WHERE e.endet_am <= p_cutoff ORDER BY e.endet_am
$$;

-- Eine Anweisung, also atomar: Einladungen und Antworten folgen per ON DELETE CASCADE.
-- Rührt keine andere Tabelle an (Rechnungen und Buchhaltung bleiben, projektplan.md, Abschnitt 6).
CREATE FUNCTION kalender_event_loeschen(p_event_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  DELETE FROM public.kalender_event WHERE id = p_event_id
$$;

REVOKE ALL ON FUNCTION kalender_abgelaufene_events(timestamptz), kalender_event_loeschen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kalender_abgelaufene_events(timestamptz), kalender_event_loeschen(uuid) TO stammbuch_worker;
