-- Anwendungsrolle und Mandanten-Hilfsfunktion.
-- Die Anwendung verbindet sich nie als Eigentümer der Tabellen, sondern als stammbuch_app.
-- stammbuch_app kann Zeilensicherheit (RLS) weder umgehen noch Schema oder Rollen ändern (SR-10, SR-11).
-- Anmelden darf die Rolle erst, wenn der Betrieb ein Passwort setzt (CLI: APP_DB_PASSWORD, siehe README).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stammbuch_app') THEN
    CREATE ROLE stammbuch_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- Fail secure (SR-54): eine vorhandene Rolle mit Sonderrechten stoppt die Migration.
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'stammbuch_app' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'Rolle stammbuch_app hat Sonderrechte (SUPERUSER, BYPASSRLS, CREATEROLE oder CREATEDB)';
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO stammbuch_app;

-- Aktueller Mandant der Transaktion. Die Anwendung setzt ihn pro Transaktion
-- (set_config('app.kunde_id', <uuid>, true)). Ohne Wert ist das Ergebnis NULL,
-- und jede Richtlinie "kunde_id = app_kunde_id()" liefert dann keine Zeilen.
CREATE FUNCTION app_kunde_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.kunde_id', true), '')::uuid $$;

REVOKE ALL ON FUNCTION app_kunde_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_kunde_id() TO stammbuch_app;
