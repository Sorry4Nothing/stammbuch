-- Die Anmeldung kennt den Kunden noch nicht: E-Mail bzw. Sitzungstoken führen erst zum Mandanten.
-- Diese zwei Funktionen sind die einzigen Wege an RLS vorbei. Sie laufen als Eigentümer (SECURITY DEFINER),
-- suchen nur über einen Schlüssel (E-Mail, Token-Hash) und geben genau eine Zeile oder keine zurück.
-- Danach setzt die Anwendung kunde_id als Mandant (withKunde) und arbeitet nur noch mit RLS.

CREATE FUNCTION benutzer_fuer_anmeldung(p_email text)
RETURNS TABLE (id uuid, kunde_id uuid, passwort_hash text, aktiv boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.kunde_id, b.passwort_hash, b.aktiv FROM public.benutzer b WHERE b.email = lower(p_email)
$$;

CREATE FUNCTION sitzung_aufloesen(p_token_hash bytea)
RETURNS TABLE (id uuid, kunde_id uuid, benutzer_id uuid, laeuft_ab_am timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.kunde_id, s.benutzer_id, s.laeuft_ab_am
  FROM public.sitzung s
  JOIN public.benutzer b ON b.id = s.benutzer_id AND b.kunde_id = s.kunde_id
  WHERE s.token_hash = p_token_hash
    AND s.widerrufen_am IS NULL
    AND s.laeuft_ab_am > now()
    AND b.aktiv
$$;

REVOKE ALL ON FUNCTION benutzer_fuer_anmeldung(text), sitzung_aufloesen(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION benutzer_fuer_anmeldung(text), sitzung_aufloesen(bytea) TO stammbuch_app;
