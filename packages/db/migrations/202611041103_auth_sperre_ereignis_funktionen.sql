-- Zwei Tabellen OHNE Mandantenbezug, weil sie vor der Mandantenwahl gebraucht werden:
--
--  auth_sperre     Fehlversuchszähler pro Konto-Schlüssel (HMAC der E-Mail). Auch für E-Mails, die es nicht
--                  gibt (sonst verriete die Sperre, welche Konten existieren, SR-05). Ein Schlüssel kann zu
--                  keinem Kunden gehören.
--  auth_ereignis   Sicherheitsereignisse ohne bekannten Mandanten (Anmeldung für unbekanntes Konto, Sperre
--                  vor der Kontosuche, abgelehnte Anfragen ohne Sitzung). Löst den offenen Designpunkt
--                  "audit_log.kunde_id ist NOT NULL": Ereignisse mit Mandant stehen in audit_log, alle
--                  anderen hier. Nur anhängen, nie Klartext-E-Mails oder Geheimnisse (SR-50).
--
-- Sie sind bewusst die einzigen Tabellen ohne kunde_id. Schutz statt RLS-Richtlinie: RLS ist aktiv, es gibt
-- KEINE Richtlinie und KEIN GRANT für stammbuch_app. Zugriff nur über die schmalen SECURITY-DEFINER-Funktionen
-- unten (feste Spalten, ein Schlüssel pro Aufruf). Das ist enger als eine Tabelle mit Rechten und einer
-- "USING (true)"-Richtlinie: die Anwendungsrolle kann nichts auflisten oder beliebig umschreiben.

CREATE TABLE auth_sperre (
  schluessel     text PRIMARY KEY CHECK (schluessel ~ '^[0-9a-f]{64}$'),
  fehlversuche   integer NOT NULL DEFAULT 0 CHECK (fehlversuche >= 0),
  letzter_fehler timestamptz NOT NULL DEFAULT now(),
  gesperrt_bis   timestamptz
);
ALTER TABLE auth_sperre ENABLE ROW LEVEL SECURITY;

CREATE TABLE auth_ereignis (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zeitpunkt   timestamptz NOT NULL DEFAULT now(),
  aktion      text NOT NULL CHECK (length(aktion) BETWEEN 1 AND 100),
  ergebnis    text NOT NULL CHECK (ergebnis IN ('success', 'failure')),
  ip          text CHECK (length(ip) <= 64),
  -- Ohne Fremdschlüssel: das Ereignis darf den Benutzer überdauern.
  benutzer_id uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(details) <= 4096)
);
CREATE INDEX auth_ereignis_zeitpunkt_idx ON auth_ereignis (zeitpunkt);
ALTER TABLE auth_ereignis ENABLE ROW LEVEL SECURITY;

-- Zähler lesen, ohne eine Zeile anzulegen.
CREATE FUNCTION auth_sperre_lesen(p_schluessel text)
RETURNS TABLE (fehlversuche integer, letzter_fehler timestamptz, gesperrt_bis timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.fehlversuche, s.letzter_fehler, s.gesperrt_bis FROM public.auth_sperre s WHERE s.schluessel = p_schluessel
$$;

-- Zeile anlegen (falls nötig) und bis zum Transaktionsende sperren: Lesen-Ändern-Schreiben ohne Rennen.
CREATE FUNCTION auth_sperre_sichern(p_schluessel text)
RETURNS TABLE (fehlversuche integer, letzter_fehler timestamptz, gesperrt_bis timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.auth_sperre (schluessel) VALUES (p_schluessel)
  ON CONFLICT (schluessel) DO UPDATE SET schluessel = excluded.schluessel
  RETURNING fehlversuche, letzter_fehler, gesperrt_bis
$$;

CREATE FUNCTION auth_sperre_setzen(
  p_schluessel text, p_fehlversuche integer, p_letzter_fehler timestamptz, p_gesperrt_bis timestamptz
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.auth_sperre
  SET fehlversuche = p_fehlversuche, letzter_fehler = p_letzter_fehler, gesperrt_bis = p_gesperrt_bis
  WHERE schluessel = p_schluessel
$$;

CREATE FUNCTION auth_sperre_loeschen(p_schluessel text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ DELETE FROM public.auth_sperre WHERE schluessel = p_schluessel $$;

CREATE FUNCTION auth_ereignis_anhaengen(
  p_zeitpunkt timestamptz, p_aktion text, p_ergebnis text, p_ip text, p_benutzer_id uuid, p_details jsonb
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.auth_ereignis (zeitpunkt, aktion, ergebnis, ip, benutzer_id, details)
  VALUES (p_zeitpunkt, p_aktion, p_ergebnis, p_ip, p_benutzer_id, coalesce(p_details, '{}'::jsonb))
$$;

-- Wartung für den Worker (kundenübergreifend, daher ohne Mandant): abgelaufene oder widerrufene Sitzungen,
-- verfallene Sperrzähler (24 h ohne Fehlversuch, wie FAILURE_DECAY_MS in throttle.ts) und alte Ereignisse
-- ohne Mandant (90 Tage; die Aufbewahrungsfrist ist offen, siehe packages/db/README.md).
CREATE FUNCTION auth_aufraeumen(p_jetzt timestamptz)
RETURNS TABLE (sitzungen bigint, sperren bigint, ereignisse bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    DELETE FROM public.sitzung WHERE laeuft_ab_am <= p_jetzt OR widerrufen_am IS NOT NULL RETURNING 1
  ), t AS (
    DELETE FROM public.auth_sperre
    WHERE letzter_fehler < p_jetzt - interval '24 hours' AND (gesperrt_bis IS NULL OR gesperrt_bis <= p_jetzt)
    RETURNING 1
  ), e AS (
    DELETE FROM public.auth_ereignis WHERE zeitpunkt < p_jetzt - interval '90 days' RETURNING 1
  )
  SELECT (SELECT count(*) FROM s), (SELECT count(*) FROM t), (SELECT count(*) FROM e)
$$;

-- Chef-Admin-Reset des zweiten Faktors wirkt auf einen Benutzer eines anderen Kunden. Die Funktion prüft in
-- der Datenbank, dass der Akteur ein aktiver chief_admin ist, und gibt nur Benutzer-ID und Kunden-ID des Ziels
-- zurück (keine Kundendaten). Alles Weitere läuft danach unter RLS im Mandanten des Ziels.
CREATE FUNCTION benutzer_fuer_mfa_reset(p_akteur uuid, p_ziel uuid)
RETURNS TABLE (id uuid, kunde_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT z.id, z.kunde_id FROM public.benutzer z
  WHERE z.id = p_ziel
    AND EXISTS (SELECT 1 FROM public.benutzer a WHERE a.id = p_akteur AND a.rolle = 'chief_admin' AND a.aktiv)
$$;

REVOKE ALL ON FUNCTION
  auth_sperre_lesen(text), auth_sperre_sichern(text), auth_sperre_setzen(text, integer, timestamptz, timestamptz),
  auth_sperre_loeschen(text), auth_ereignis_anhaengen(timestamptz, text, text, text, uuid, jsonb),
  auth_aufraeumen(timestamptz), benutzer_fuer_mfa_reset(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth_sperre_lesen(text), auth_sperre_sichern(text), auth_sperre_setzen(text, integer, timestamptz, timestamptz),
  auth_sperre_loeschen(text), auth_ereignis_anhaengen(timestamptz, text, text, text, uuid, jsonb),
  auth_aufraeumen(timestamptz), benutzer_fuer_mfa_reset(uuid, uuid)
TO stammbuch_app;
