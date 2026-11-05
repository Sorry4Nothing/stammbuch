-- Öffentliche Kennung eines Kunden für die Selbstregistrierung (/public/<slug>/…).
-- Die Anwendungsrolle darf sie nicht ändern (GRANT UPDATE nur auf name); setzen darf sie der Eigentümer.

ALTER TABLE kunde
  ADD COLUMN slug text UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- Der Mandant ist vor der Auflösung unbekannt, daher am RLS vorbei. Gibt nur die ID zurück.
CREATE FUNCTION kunde_id_fuer_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$ SELECT k.id FROM public.kunde k WHERE k.slug = p_slug $$;

REVOKE ALL ON FUNCTION kunde_id_fuer_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kunde_id_fuer_slug(text) TO stammbuch_app;
