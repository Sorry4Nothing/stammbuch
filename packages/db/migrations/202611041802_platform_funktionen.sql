-- Wege an RLS vorbei für die Platform (Chef-Admin und Einladungen), jeweils schmal, mit festen Spalten (SECURITY DEFINER).
--
-- Der Chef-Admin arbeitet über alle Kunden hinweg, sieht aber nur Vertragsdaten. Jede Funktion mit Parameter
-- `p_akteur` prüft in der Datenbank, dass der Akteur ein aktiver `chief_admin` ist (wie benutzer_fuer_mfa_reset).
-- Die Anwendung übergibt die Benutzer-ID aus der serverseitig aufgelösten Sitzung, nie aus dem Request (SR-13).
-- Lesende Funktionen liefern ohne Chef-Admin keine Zeilen, schreibende brechen mit 42501 ab (fail closed, SR-54).

-- Konto des Chef-Admins. Wird auch als Prüfung der anderen Funktionen benutzt.
CREATE FUNCTION chef_konto(p_akteur uuid)
RETURNS TABLE (id uuid, email text, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.email, b.name FROM public.benutzer b
  WHERE b.id = p_akteur AND b.rolle = 'chief_admin' AND b.aktiv
$$;

CREATE FUNCTION chef_konto_aendern(p_akteur uuid, p_name text)
RETURNS TABLE (id uuid, email text, name text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.benutzer b SET name = p_name
  WHERE b.id = p_akteur AND b.rolle = 'chief_admin' AND b.aktiv
  RETURNING b.id, b.email, b.name
$$;

-- Alle Kunden (Vertragsdaten) mit Filter und Seite. Die letzte Spalte ist die Gesamtzahl; sie steht auch dann in
-- der einen Zeile, wenn die Seite leer ist (dann sind die anderen Spalten NULL).
CREATE FUNCTION kunden_auflisten(p_akteur uuid, p_status text, p_muster text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid, name text, status text, lizenz_gueltig_bis date, erstellt_am timestamptz, beendet_am timestamptz, gesamt bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH f AS (
    SELECT k.id, k.name, k.status, k.lizenz_gueltig_bis, k.erstellt_am, k.beendet_am
    FROM public.kunde k
    WHERE EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
      AND (p_status IS NULL OR k.status = p_status)
      AND (p_muster IS NULL OR k.name ILIKE p_muster)
  )
  SELECT p.id, p.name, p.status, p.lizenz_gueltig_bis, p.erstellt_am, p.beendet_am, (SELECT count(*) FROM f)
  FROM (SELECT 1) eins
  LEFT JOIN LATERAL (SELECT * FROM f ORDER BY lower(f.name), f.id LIMIT p_limit OFFSET p_offset) p ON true
  ORDER BY lower(p.name), p.id
$$;

CREATE FUNCTION kunde_anlegen(p_akteur uuid, p_id uuid, p_name text, p_lizenz date, p_erstellt timestamptz)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf Kunden anlegen' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.kunde (id, name, lizenz_gueltig_bis, erstellt_am) VALUES (p_id, p_name, p_lizenz, p_erstellt);
END
$$;

-- Ändert nur, was nicht NULL ist. `beendet_am` gehört zum Status 'ended' (CHECK kunde_beendet_konsistent).
CREATE FUNCTION kunde_aendern(
  p_akteur uuid, p_id uuid, p_name text, p_status text, p_lizenz date, p_beendet timestamptz
)
RETURNS TABLE (
  id uuid, name text, status text, lizenz_gueltig_bis date, erstellt_am timestamptz, beendet_am timestamptz
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
    status = coalesce(p_status, k.status),
    lizenz_gueltig_bis = coalesce(p_lizenz, k.lizenz_gueltig_bis),
    beendet_am = coalesce(p_beendet, k.beendet_am)
  WHERE k.id = p_id
  RETURNING k.id, k.name, k.status, k.lizenz_gueltig_bis, k.erstellt_am, k.beendet_am;
END
$$;

CREATE FUNCTION plattform_protokoll_anhaengen(
  p_akteur uuid, p_id uuid, p_zeitpunkt timestamptz, p_akteur_text text, p_aktion text, p_ziel text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin schreibt ins Plattformprotokoll' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.plattform_protokoll (id, zeitpunkt, akteur_id, akteur, aktion, ziel)
  VALUES (p_id, p_zeitpunkt, p_akteur, p_akteur_text, p_aktion, p_ziel);
END
$$;

-- Lesen ohne Akteur: das Plattformprotokoll enthält nur Vertragsvorgänge (Kundenname, Aktion), nie Kundendaten.
-- Die Route verlangt den Chef-Admin. Neueste zuerst; letzte Spalte wie bei kunden_auflisten.
CREATE FUNCTION plattform_protokoll_lesen(
  p_von timestamptz, p_bis timestamptz, p_akteur text, p_aktion text, p_muster text, p_limit integer, p_offset integer
)
RETURNS TABLE (id uuid, zeitpunkt timestamptz, akteur_id uuid, akteur text, aktion text, ziel text, gesamt bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH f AS (
    SELECT e.id, e.zeitpunkt, e.akteur_id, e.akteur, e.aktion, e.ziel
    FROM public.plattform_protokoll e
    WHERE (p_von IS NULL OR e.zeitpunkt >= p_von)
      AND (p_bis IS NULL OR e.zeitpunkt <= p_bis)
      AND (p_akteur IS NULL OR e.akteur ILIKE p_akteur)
      AND (p_aktion IS NULL OR e.aktion = p_aktion)
      AND (p_muster IS NULL OR (e.aktion || ' ' || e.ziel || ' ' || e.akteur) ILIKE p_muster)
  )
  SELECT p.id, p.zeitpunkt, p.akteur_id, p.akteur, p.aktion, p.ziel, (SELECT count(*) FROM f)
  FROM (SELECT 1) eins
  LEFT JOIN LATERAL (
    SELECT * FROM f ORDER BY f.zeitpunkt DESC, f.id DESC LIMIT p_limit OFFSET p_offset
  ) p ON true
  ORDER BY p.zeitpunkt DESC, p.id DESC
$$;

-- Einladung einlösen: das Token führt erst zum Kunden. Eine Anweisung, also atomar: ein Token gilt genau einmal.
-- Abgelaufen oder schon benutzt: keine Zeile.
CREATE FUNCTION einladung_einloesen(p_token_hash bytea, p_jetzt timestamptz)
RETURNS TABLE (
  id uuid, kunde_id uuid, email text, rolle text, benutzer_id uuid,
  erstellt_am timestamptz, laeuft_ab_am timestamptz, eingeloest_am timestamptz
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.einladung e SET eingeloest_am = p_jetzt
  WHERE e.token_hash = p_token_hash AND e.eingeloest_am IS NULL AND e.laeuft_ab_am > p_jetzt
  RETURNING e.id, e.kunde_id, e.email, e.rolle, e.benutzer_id, e.erstellt_am, e.laeuft_ab_am, e.eingeloest_am
$$;

REVOKE ALL ON FUNCTION
  chef_konto(uuid), chef_konto_aendern(uuid, text), kunden_auflisten(uuid, text, text, integer, integer),
  kunde_anlegen(uuid, uuid, text, date, timestamptz), kunde_aendern(uuid, uuid, text, text, date, timestamptz),
  plattform_protokoll_anhaengen(uuid, uuid, timestamptz, text, text, text),
  plattform_protokoll_lesen(timestamptz, timestamptz, text, text, text, integer, integer),
  einladung_einloesen(bytea, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  chef_konto(uuid), chef_konto_aendern(uuid, text), kunden_auflisten(uuid, text, text, integer, integer),
  kunde_anlegen(uuid, uuid, text, date, timestamptz), kunde_aendern(uuid, uuid, text, text, date, timestamptz),
  plattform_protokoll_anhaengen(uuid, uuid, timestamptz, text, text, text),
  plattform_protokoll_lesen(timestamptz, timestamptz, text, text, text, integer, integer),
  einladung_einloesen(bytea, timestamptz)
TO stammbuch_app;
