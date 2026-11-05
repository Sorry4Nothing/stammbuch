-- Schlüsselrotation, Teil 2 (Issues #73, #74): TOTP-Geheimnisse, Auslösen durch den Chef-Admin, Stand ohne Dopplung.
-- Alle Funktionen: SECURITY DEFINER mit festem search_path, REVOKE FROM PUBLIC, Rechte nur für die genannte Rolle.
-- Worker (stammbuch_worker): ohne Akteur, wie Migration ...1100. API (stammbuch_app): jede Funktion prüft in der
-- Datenbank, dass der Akteur ein aktiver `chief_admin` ist (chef_konto). Der Akteur kommt aus der Sitzung (SR-13).

-- Stand je Art (mail, totp): letzter Lauf, aktuell unlesbare Objekte (nur IDs, nie Schlüssel oder Klartext) und die
-- Menge, die zuletzt gemeldet (Log und Protokoll) wurde. Gehört keinem Kunden: RLS aktiv, KEINE Richtlinie,
-- KEIN GRANT (wie plattform_protokoll). Zugriff nur über die Funktionen unten.
CREATE TABLE schluesselrotation_stand (
  art               text PRIMARY KEY CHECK (art IN ('mail', 'totp')),
  gelaufen_am       timestamptz NOT NULL,
  unlesbar          uuid[] NOT NULL DEFAULT '{}',
  gemeldet_am       timestamptz,
  gemeldet_unlesbar uuid[] NOT NULL DEFAULT '{}'
);

ALTER TABLE schluesselrotation_stand ENABLE ROW LEVEL SECURITY;

-- TOTP-Geheimnisse, die nicht mit dem Schlüssel p_schluessel_id verschlüsselt sind (Format v1.<keyId>.<iv>.<tag>.<ct>;
-- das Altformat v1.<iv>.<tag>.<ct> hat nur vier Teile und gilt immer als zu rotieren). Seitenweise nach ID wie bei Mail.
CREATE FUNCTION totp_zur_rotation(p_schluessel_id text, p_nach uuid, p_limit integer)
RETURNS TABLE (id uuid, kunde_id uuid, geheimnis_enc text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.kunde_id, b.totp_secret_enc FROM public.benutzer b
  WHERE b.totp_secret_enc IS NOT NULL
    AND (split_part(b.totp_secret_enc, '.', 5) = '' OR split_part(b.totp_secret_enc, '.', 2) <> p_schluessel_id)
    AND (p_nach IS NULL OR b.id > p_nach)
  ORDER BY b.id
  LIMIT least(greatest(p_limit, 0), 1000)
$$;

-- Compare-and-swap: eine gleichzeitige Neueinrichtung (anderes Geheimnis) wird nicht überschrieben.
CREATE FUNCTION totp_geheimnis_ersetzen(p_kunde_id uuid, p_id uuid, p_alt text, p_neu text)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH u AS (
    UPDATE public.benutzer b SET totp_secret_enc = p_neu
    WHERE b.id = p_id AND b.kunde_id = p_kunde_id AND b.totp_secret_enc = p_alt
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Hält das Ergebnis eines Laufs fest und sagt, ob es zu melden ist: nur wenn sich die Menge der unlesbaren Objekte
-- gegenüber der letzten Meldung geändert hat (auch auf leer) oder die letzte Meldung einen Tag zurückliegt.
-- Verhindert die stündliche Wiederholung bei dauerhaft unlesbaren Konten. Nur für die Wrapper und den Worker.
CREATE FUNCTION rotation_stand_festhalten(p_art text, p_jetzt timestamptz, p_unlesbar uuid[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  s public.schluesselrotation_stand%ROWTYPE;
  v_melden boolean;
BEGIN
  INSERT INTO public.schluesselrotation_stand AS t (art, gelaufen_am, unlesbar)
  VALUES (p_art, p_jetzt, coalesce((SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_unlesbar) x), '{}'))
  ON CONFLICT (art) DO UPDATE SET gelaufen_am = EXCLUDED.gelaufen_am, unlesbar = EXCLUDED.unlesbar
  RETURNING t.* INTO s;
  v_melden := s.unlesbar <> s.gemeldet_unlesbar
    OR coalesce(cardinality(s.unlesbar) > 0 AND p_jetzt - s.gemeldet_am >= interval '1 day', false);
  IF v_melden THEN
    UPDATE public.schluesselrotation_stand SET gemeldet_am = p_jetzt, gemeldet_unlesbar = s.unlesbar WHERE art = p_art;
  END IF;
  RETURN v_melden;
END
$$;

-- Der Worker darf zusätzlich die TOTP-Rotation protokollieren (feste Aktionen, fester Akteur `worker`).
CREATE OR REPLACE FUNCTION plattform_protokoll_vom_worker(p_id uuid, p_zeitpunkt timestamptz, p_aktion text, p_ziel text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_aktion NOT IN ('mail.rotate-secrets', 'auth.rotate-totp') THEN
    RAISE EXCEPTION 'Der Worker darf diese Aktion nicht protokollieren' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.plattform_protokoll (id, zeitpunkt, akteur_id, akteur, aktion, ziel)
  VALUES (p_id, p_zeitpunkt, '00000000-0000-0000-0000-000000000000', 'worker', p_aktion, p_ziel);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Chef-Admin (Rolle stammbuch_app): dieselben Schritte mit Akteurprüfung. Lesende Funktionen liefern ohne
-- Chef-Admin keine Zeilen, schreibende brechen mit 42501 ab (fail closed, SR-54).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION mail_konten_zur_rotation_chef(p_akteur uuid, p_schluessel_id text, p_nach uuid, p_limit integer)
RETURNS TABLE (id uuid, kunde_id uuid, geheimnis_enc text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.id, m.kunde_id, m.geheimnis_enc FROM public.mail_konten_zur_rotation(p_schluessel_id, p_nach, p_limit) m
  WHERE EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY m.id
$$;

CREATE FUNCTION totp_zur_rotation_chef(p_akteur uuid, p_schluessel_id text, p_nach uuid, p_limit integer)
RETURNS TABLE (id uuid, kunde_id uuid, geheimnis_enc text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.kunde_id, t.geheimnis_enc FROM public.totp_zur_rotation(p_schluessel_id, p_nach, p_limit) t
  WHERE EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY t.id
$$;

CREATE FUNCTION mail_konto_geheimnis_ersetzen_chef(p_akteur uuid, p_kunde_id uuid, p_id uuid, p_alt text, p_neu text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf die Schlüsselrotation auslösen' USING ERRCODE = '42501';
  END IF;
  RETURN public.mail_konto_geheimnis_ersetzen(p_kunde_id, p_id, p_alt, p_neu);
END
$$;

CREATE FUNCTION totp_geheimnis_ersetzen_chef(p_akteur uuid, p_kunde_id uuid, p_id uuid, p_alt text, p_neu text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf die Schlüsselrotation auslösen' USING ERRCODE = '42501';
  END IF;
  RETURN public.totp_geheimnis_ersetzen(p_kunde_id, p_id, p_alt, p_neu);
END
$$;

-- Ein manueller Lauf meldet immer: der Chef-Admin sieht das Ergebnis und das Plattformprotokoll bekommt den Eintrag.
CREATE FUNCTION rotation_stand_festhalten_chef(p_akteur uuid, p_art text, p_jetzt timestamptz, p_unlesbar uuid[])
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf die Schlüsselrotation auslösen' USING ERRCODE = '42501';
  END IF;
  PERFORM public.rotation_stand_festhalten(p_art, p_jetzt, p_unlesbar);
END
$$;

-- Unlesbare Objekte (nur IDs) und Zeitpunkt des letzten Laufs je Art, für den Chef-Admin.
CREATE FUNCTION rotation_stand_lesen(p_akteur uuid)
RETURNS TABLE (art text, gelaufen_am timestamptz, unlesbar uuid[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.art, s.gelaufen_am, s.unlesbar FROM public.schluesselrotation_stand s
  WHERE EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY s.art
$$;

REVOKE ALL ON FUNCTION
  totp_zur_rotation(text, uuid, integer),
  totp_geheimnis_ersetzen(uuid, uuid, text, text),
  rotation_stand_festhalten(text, timestamptz, uuid[]),
  mail_konten_zur_rotation_chef(uuid, text, uuid, integer),
  totp_zur_rotation_chef(uuid, text, uuid, integer),
  mail_konto_geheimnis_ersetzen_chef(uuid, uuid, uuid, text, text),
  totp_geheimnis_ersetzen_chef(uuid, uuid, uuid, text, text),
  rotation_stand_festhalten_chef(uuid, text, timestamptz, uuid[]),
  rotation_stand_lesen(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  totp_zur_rotation(text, uuid, integer),
  totp_geheimnis_ersetzen(uuid, uuid, text, text),
  rotation_stand_festhalten(text, timestamptz, uuid[])
TO stammbuch_worker;

GRANT EXECUTE ON FUNCTION
  mail_konten_zur_rotation_chef(uuid, text, uuid, integer),
  totp_zur_rotation_chef(uuid, text, uuid, integer),
  mail_konto_geheimnis_ersetzen_chef(uuid, uuid, uuid, text, text),
  totp_geheimnis_ersetzen_chef(uuid, uuid, uuid, text, text),
  rotation_stand_festhalten_chef(uuid, text, timestamptz, uuid[]),
  rotation_stand_lesen(uuid)
TO stammbuch_app;
