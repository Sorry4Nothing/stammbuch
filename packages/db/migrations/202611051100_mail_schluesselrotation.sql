-- Schlüsselrotation der Postfach-Zugangsdaten über alle Kunden (Rolle stammbuch_worker, wie Migration ...605).
-- Der Worker hat keine Tabellenrechte: nur diese schmalen Funktionen. Die API (stammbuch_app) kann sie nicht aufrufen.

-- Konten, deren Chiffretext nicht mit dem Schlüssel p_schluessel_id verschlüsselt ist (Format v1.<keyId>.…).
-- Seitenweise nach ID (Cursor p_nach): ein Konto, das sich nicht umschlüsseln lässt, blockiert den Lauf nicht,
-- und ein abgebrochener Lauf setzt beim nächsten Aufruf einfach neu auf (schon umgeschlüsselte Konten fallen heraus).
CREATE FUNCTION mail_konten_zur_rotation(p_schluessel_id text, p_nach uuid, p_limit integer)
RETURNS SETOF mail_konto
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.* FROM public.mail_konto m
  WHERE split_part(m.geheimnis_enc, '.', 2) <> p_schluessel_id
    AND (p_nach IS NULL OR m.id > p_nach)
  ORDER BY m.id
  LIMIT least(greatest(p_limit, 0), 1000)
$$;

-- Ersetzt den Chiffretext nur, wenn er noch dem gelesenen Stand entspricht (Compare-and-swap): ändert ein
-- Benutzer das Passwort zwischen Lesen und Schreiben, gewinnt seine Änderung, es geht nichts verloren.
CREATE FUNCTION mail_konto_geheimnis_ersetzen(p_kunde_id uuid, p_id uuid, p_alt text, p_neu text)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH u AS (
    UPDATE public.mail_konto m SET geheimnis_enc = p_neu
    WHERE m.id = p_id AND m.kunde_id = p_kunde_id AND m.geheimnis_enc = p_alt
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Protokolleintrag des Workers im Plattformprotokoll: feste Aktion, fester Akteur (keine Anmeldung, daher Nil-UUID).
CREATE FUNCTION plattform_protokoll_vom_worker(p_id uuid, p_zeitpunkt timestamptz, p_aktion text, p_ziel text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_aktion <> 'mail.rotate-secrets' THEN
    RAISE EXCEPTION 'Der Worker darf diese Aktion nicht protokollieren' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.plattform_protokoll (id, zeitpunkt, akteur_id, akteur, aktion, ziel)
  VALUES (p_id, p_zeitpunkt, '00000000-0000-0000-0000-000000000000', 'worker', p_aktion, p_ziel);
END
$$;

REVOKE ALL ON FUNCTION
  mail_konten_zur_rotation(text, uuid, integer),
  mail_konto_geheimnis_ersetzen(uuid, uuid, text, text),
  plattform_protokoll_vom_worker(uuid, timestamptz, text, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  mail_konten_zur_rotation(text, uuid, integer),
  mail_konto_geheimnis_ersetzen(uuid, uuid, text, text),
  plattform_protokoll_vom_worker(uuid, timestamptz, text, text)
TO stammbuch_worker;
