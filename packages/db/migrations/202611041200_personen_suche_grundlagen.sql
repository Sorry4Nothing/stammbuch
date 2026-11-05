-- Grundlagen für Suche und Sortierung im Personen-Modul (Mitglieder, Firmenregister).
-- unaccent: "Müller" findet "muller"; pg_trgm: Teilstring-Suche (LIKE '%…%') über GIN-Index.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Vergleichsform: ohne Akzente, klein, alles ausser Buchstaben und Ziffern wird zu einem
-- Leerzeichen. Nicht-ASCII-Zeichen bleiben erhalten (unabhängig von der Locale der Datenbank).
-- IMMUTABLE, damit sie in Indizes und generierten Spalten stehen darf.
CREATE FUNCTION suchtext_normalisieren(p_text text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = pg_catalog, public
AS $$
  SELECT btrim(regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, p_text)),
                              '[^a-z0-9\u0080-￿]+', ' ', 'g'))
$$;

REVOKE ALL ON FUNCTION suchtext_normalisieren(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION suchtext_normalisieren(text) TO stammbuch_app;
