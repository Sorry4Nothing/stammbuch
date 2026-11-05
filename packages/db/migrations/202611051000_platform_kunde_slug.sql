-- Kunden-Slug in den Funktionen des Chef-Admins (Issue #58).
--
-- `kunde_anlegen` nimmt den Slug entgegen (die Anwendung erzeugt ihn aus dem Kundennamen, bei Kollision mit Suffix;
-- UNIQUE auf kunde.slug schützt vor der Rennbedingung). `kunde_aendern` korrigiert ihn später (NULL = unverändert),
-- `kunden_auflisten` liefert ihn mit. Die Anwendungsrolle darf die Spalte weiterhin nicht selbst schreiben
-- (GRANT UPDATE nur auf name): nur diese Funktionen, und die prüfen den Akteur als aktiven Chef-Admin.
-- Das Format erzwingt der CHECK der Spalte; bestehende Kunden ohne Slug bleiben unverändert (NULL).
-- Rückgabetyp und Parameterliste ändern sich, daher DROP und neu anlegen.

DROP FUNCTION kunde_anlegen(uuid, uuid, text, date, timestamptz);
DROP FUNCTION kunde_aendern(uuid, uuid, text, text, date, timestamptz);
DROP FUNCTION kunden_auflisten(uuid, text, text, integer, integer);

CREATE FUNCTION kunden_auflisten(p_akteur uuid, p_status text, p_muster text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid, name text, slug text, status text, lizenz_gueltig_bis date, erstellt_am timestamptz, beendet_am timestamptz,
  gesamt bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH f AS (
    SELECT k.id, k.name, k.slug, k.status, k.lizenz_gueltig_bis, k.erstellt_am, k.beendet_am
    FROM public.kunde k
    WHERE EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
      AND (p_status IS NULL OR k.status = p_status)
      AND (p_muster IS NULL OR k.name ILIKE p_muster)
  )
  SELECT p.id, p.name, p.slug, p.status, p.lizenz_gueltig_bis, p.erstellt_am, p.beendet_am, (SELECT count(*) FROM f)
  FROM (SELECT 1) eins
  LEFT JOIN LATERAL (SELECT * FROM f ORDER BY lower(f.name), f.id LIMIT p_limit OFFSET p_offset) p ON true
  ORDER BY lower(p.name), p.id
$$;

CREATE FUNCTION kunde_anlegen(
  p_akteur uuid, p_id uuid, p_name text, p_lizenz date, p_erstellt timestamptz, p_slug text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf Kunden anlegen' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.kunde (id, name, lizenz_gueltig_bis, erstellt_am, slug)
  VALUES (p_id, p_name, p_lizenz, p_erstellt, p_slug);
END
$$;

CREATE FUNCTION kunde_aendern(
  p_akteur uuid, p_id uuid, p_name text, p_status text, p_lizenz date, p_beendet timestamptz, p_slug text
)
RETURNS TABLE (
  id uuid, name text, slug text, status text, lizenz_gueltig_bis date, erstellt_am timestamptz, beendet_am timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf Kunden ändern' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  UPDATE public.kunde k SET
    name = coalesce(p_name, k.name),
    slug = coalesce(p_slug, k.slug),
    status = coalesce(p_status, k.status),
    lizenz_gueltig_bis = coalesce(p_lizenz, k.lizenz_gueltig_bis),
    beendet_am = coalesce(p_beendet, k.beendet_am)
  WHERE k.id = p_id
  RETURNING k.id, k.name, k.slug, k.status, k.lizenz_gueltig_bis, k.erstellt_am, k.beendet_am;
END
$$;

REVOKE ALL ON FUNCTION
  kunden_auflisten(uuid, text, text, integer, integer),
  kunde_anlegen(uuid, uuid, text, date, timestamptz, text),
  kunde_aendern(uuid, uuid, text, text, date, timestamptz, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  kunden_auflisten(uuid, text, text, integer, integer),
  kunde_anlegen(uuid, uuid, text, date, timestamptz, text),
  kunde_aendern(uuid, uuid, text, text, date, timestamptz, text)
TO stammbuch_app;
