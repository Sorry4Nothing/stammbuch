-- Wege an RLS vorbei für den Mailversand im Worker (Rolle stammbuch_worker, siehe Kalender-Migration).
-- Der Worker arbeitet mandantenübergreifend, hat aber keine Tabellenrechte: nur diese Funktionen mit festen
-- Spalten, jeweils für genau einen Schlüssel. Die API (stammbuch_app) kann sie nicht aufrufen.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stammbuch_worker') THEN
    CREATE ROLE stammbuch_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO stammbuch_worker;

-- Fällige Zustellungen: queued mit erreichtem Zeitpunkt oder sending mit abgelaufener Sperre.
CREATE FUNCTION mail_zustellungen_faellig(p_jetzt timestamptz, p_limit integer)
RETURNS SETOF mail_zustellung
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT z.* FROM public.mail_zustellung z
  WHERE (z.status = 'queued' AND z.naechster_versuch_am <= p_jetzt)
     OR (z.status = 'sending' AND z.lease_bis < p_jetzt)
  ORDER BY z.naechster_versuch_am
  LIMIT least(greatest(p_limit, 0), 1000)
$$;

-- Atomar übernehmen: gewinnt genau ein Worker. Kein Treffer = schon übernommen, abgebrochen oder noch nicht fällig.
CREATE FUNCTION mail_zustellung_uebernehmen(p_id uuid, p_jetzt timestamptz, p_lease_bis timestamptz)
RETURNS SETOF mail_zustellung
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.mail_zustellung z
  SET status = 'sending', versuche = z.versuche + 1, lease_bis = p_lease_bis
  WHERE z.id = p_id
    AND ((z.status = 'queued' AND z.naechster_versuch_am <= p_jetzt)
      OR (z.status = 'sending' AND z.lease_bis < p_jetzt))
  RETURNING z.*
$$;

-- Ergebnis eintragen; nur für eine übernommene (sending) Zustellung.
CREATE FUNCTION mail_zustellung_abschliessen(
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
  WHERE z.id = p_id AND z.status = 'sending' AND p_status IN ('sent', 'queued', 'failed')
$$;

-- Kampagne ohne Bestätigungs-Token.
CREATE FUNCTION mail_kampagne_fuer_worker(p_id uuid)
RETURNS TABLE (
  id uuid, kunde_id uuid, benutzer_id uuid, konto_id uuid, art text, betreff text, inhalt_html text,
  anhang_ids text[], geplant_am timestamptz, status text, empfaenger_anzahl integer,
  erstellt_am timestamptz, bestaetigt_am timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.id, k.kunde_id, k.benutzer_id, k.konto_id, k.art, k.betreff, k.inhalt_html,
         k.anhang_ids, k.geplant_am, k.status, k.empfaenger_anzahl, k.erstellt_am, k.bestaetigt_am
  FROM public.mail_kampagne k WHERE k.id = p_id
$$;

-- Konto mit Chiffretext: nötig für den Versand. Mandant und ID müssen beide stimmen.
CREATE FUNCTION mail_konto_fuer_worker(p_kunde_id uuid, p_id uuid)
RETURNS SETOF mail_konto
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.* FROM public.mail_konto m WHERE m.id = p_id AND m.kunde_id = p_kunde_id
$$;

CREATE FUNCTION mail_anhang_fuer_worker(p_kunde_id uuid, p_id uuid)
RETURNS SETOF mail_anhang
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.* FROM public.mail_anhang a WHERE a.id = p_id AND a.kunde_id = p_kunde_id
$$;

-- Zähler für das Limit pro Kunde und Minute.
CREATE FUNCTION mail_gesendet_seit(p_kunde_id uuid, p_seit timestamptz)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM public.mail_zustellung z
  WHERE z.kunde_id = p_kunde_id AND z.status = 'sent' AND z.gesendet_am >= p_seit
$$;

REVOKE ALL ON FUNCTION
  mail_zustellungen_faellig(timestamptz, integer),
  mail_zustellung_uebernehmen(uuid, timestamptz, timestamptz),
  mail_zustellung_abschliessen(uuid, text, timestamptz, text, text, timestamptz),
  mail_kampagne_fuer_worker(uuid),
  mail_konto_fuer_worker(uuid, uuid),
  mail_anhang_fuer_worker(uuid, uuid),
  mail_gesendet_seit(uuid, timestamptz)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  mail_zustellungen_faellig(timestamptz, integer),
  mail_zustellung_uebernehmen(uuid, timestamptz, timestamptz),
  mail_zustellung_abschliessen(uuid, text, timestamptz, text, text, timestamptz),
  mail_kampagne_fuer_worker(uuid),
  mail_konto_fuer_worker(uuid, uuid),
  mail_anhang_fuer_worker(uuid, uuid),
  mail_gesendet_seit(uuid, timestamptz)
TO stammbuch_worker;
