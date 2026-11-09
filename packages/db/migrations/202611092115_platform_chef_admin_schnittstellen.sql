-- Chef-Admin-Schnittstellen (Issue #115): Lizenzdaten am Kunden, Benutzerübersicht eines Kunden, Sicherheitsstand
-- des eigenen Kontos. Alles Neue ist additiv: die Funktionen aus 202611041802 und 202611051000 bleiben unverändert.
--
-- Mandantentrennung: Die Anwendungsrolle liest `kunde` nur im eigenen Mandanten (RLS) und kann die neuen Spalten nicht
-- schreiben (kein GRANT UPDATE). Alles, was der Chef-Admin über mehrere Kunden sieht oder schreibt, läuft über
-- SECURITY-DEFINER-Funktionen mit festen Spalten, die den Akteur als aktiven `chief_admin` in der Datenbank prüfen
-- (fail closed: ohne Chef-Admin keine Zeilen). Der Chef-Admin sieht dabei Name, E-Mail, Stand des zweiten Faktors und
-- Zeitpunkt der letzten Anmeldung von Benutzern, nie Daten aus dem Betrieb eines Kunden.

-- Lizenznummer: fortlaufend, vergibt die Datenbank beim Anlegen (Format L-0001). NULL = nicht erfasst.
-- Lizenzbeginn und Module: NULL bei Altkunden, deren Vertrag das nicht kennt (die Oberfläche zeigt dann «–»).
CREATE SEQUENCE kunde_lizenz_nr_seq;

ALTER TABLE kunde
  ADD COLUMN lizenz_nr text UNIQUE CHECK (lizenz_nr ~ '^L-[0-9]{4,}$'),
  ADD COLUMN lizenz_beginn date,
  ADD COLUMN module text[] CHECK (module <@ ARRAY['sammelrechnung', 'mail', 'kalender']::text[]);

-- Bestehende Kunden bekommen in der Reihenfolge ihrer Erfassung eine Nummer.
WITH nummeriert AS (
  SELECT id, row_number() OVER (ORDER BY erstellt_am, id) AS n FROM kunde
)
UPDATE kunde k SET lizenz_nr = 'L-' || lpad(nummeriert.n::text, 4, '0') FROM nummeriert WHERE nummeriert.id = k.id;
SELECT setval('kunde_lizenz_nr_seq', greatest((SELECT count(*) FROM kunde), 1), (SELECT count(*) FROM kunde) > 0);

-- Jeder neue Kunde bekommt eine Nummer, auch über die alte Signatur von kunde_anlegen. Das Setzen ist keine
-- Berechtigung der Anwendungsrolle: nur die Funktionen (Eigentümer) schreiben die Spalte.
CREATE FUNCTION kunde_lizenz_nr_vergeben() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.lizenz_nr := 'L-' || lpad(nextval('public.kunde_lizenz_nr_seq')::text, 4, '0');
  RETURN NEW;
END
$$;
CREATE TRIGGER kunde_lizenz_nr BEFORE INSERT ON kunde
  FOR EACH ROW EXECUTE FUNCTION kunde_lizenz_nr_vergeben();

-- Anlegen mit Lizenzbeginn und Modulen (weitere Signatur; die ohne diese Angaben bleibt gültig).
CREATE FUNCTION kunde_anlegen(
  p_akteur uuid, p_id uuid, p_name text, p_lizenz date, p_erstellt timestamptz, p_slug text,
  p_beginn date, p_module text[]
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chef_konto(p_akteur)) THEN
    RAISE EXCEPTION 'Nur der Chef-Admin darf Kunden anlegen' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.kunde (id, name, lizenz_gueltig_bis, erstellt_am, slug, lizenz_beginn, module)
  VALUES (p_id, p_name, p_lizenz, p_erstellt, p_slug, p_beginn, p_module);
END
$$;

-- Lizenzdaten und Benutzerzahl für eine Liste von Kunden. Gezählt werden aktive Benutzer (ohne Chef-Admins).
CREATE FUNCTION kunden_vertrag(p_akteur uuid, p_ids uuid[])
RETURNS TABLE (id uuid, lizenz_nr text, lizenz_beginn date, module text[], benutzer_anzahl bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.id, k.lizenz_nr, k.lizenz_beginn, k.module,
         (SELECT count(*) FROM public.benutzer b WHERE b.kunde_id = k.id AND b.rolle = 'user' AND b.aktiv)
  FROM public.kunde k
  WHERE k.id = ANY (p_ids) AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
$$;

-- Aktive Benutzer eines Kunden mit Stand des zweiten Faktors und letzter Anmeldung (volle Sitzung bzw. Einrichtung des
-- zweiten Faktors, aus dem Protokoll des Kunden). Keine Passwort-Hashes, Geheimnisse oder Codes.
CREATE FUNCTION kunde_benutzer_fuer_chef(p_akteur uuid, p_kunde uuid)
RETURNS TABLE (id uuid, name text, email text, totp_eingerichtet boolean, letzte_anmeldung timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.name, b.email, b.totp_eingerichtet_am IS NOT NULL,
         (SELECT max(a.zeitpunkt) FROM public.audit_log a
           WHERE a.kunde_id = b.kunde_id AND a.benutzer_id = b.id
             AND a.aktion IN ('mfa_success', 'mfa_enrolled', 'recovery_used'))
  FROM public.benutzer b
  WHERE b.kunde_id = p_kunde AND b.rolle = 'user' AND b.aktiv
    AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY lower(b.name), b.id
$$;

-- Sicherheitsstand des eigenen Chef-Admin-Kontos. Zeitpunkt der letzten Passwortänderung aus der Spalte
-- `benutzer.passwort_geaendert_am` (#114), davor aus dem Protokoll (NULL: nie geändert);Wiederherstellungscodes nur als Zahl.
CREATE FUNCTION chef_sicherheit(p_akteur uuid)
RETURNS TABLE (totp_eingerichtet_am timestamptz, codes_unbenutzt bigint, passwort_geaendert_am timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.totp_eingerichtet_am,
         (SELECT count(*) FROM public.wiederherstellungscode w WHERE w.benutzer_id = b.id AND w.kunde_id = b.kunde_id),
         COALESCE(b.passwort_geaendert_am,
           (SELECT max(a.zeitpunkt) FROM public.audit_log a
             WHERE a.kunde_id = b.kunde_id AND a.benutzer_id = b.id AND a.aktion IN ('password_changed', 'password_reset_done')))
  FROM public.benutzer b
  WHERE b.id = p_akteur AND b.rolle = 'chief_admin' AND b.aktiv
$$;

-- Offene Sitzungen des Chef-Admins (volle Stufe, nicht widerrufen, nicht abgelaufen). `aktuell`: die Sitzung der Anfrage.
CREATE FUNCTION chef_sitzungen(p_akteur uuid, p_token_hash bytea)
RETURNS TABLE (id uuid, erstellt_am timestamptz, aktuell boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.erstellt_am, s.token_hash = p_token_hash
  FROM public.sitzung s
  WHERE s.benutzer_id = p_akteur AND s.phase = 'full' AND s.widerrufen_am IS NULL AND s.laeuft_ab_am > now()
    AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY s.erstellt_am DESC, s.id DESC
$$;

-- Beendet eine andere Sitzung desselben Chef-Admins. Die eigene Sitzung bleibt (dafür gibt es das Abmelden).
-- Liefert true, wenn eine Sitzung beendet wurde. Fremde und unbekannte IDs ändern nichts.
CREATE FUNCTION chef_sitzung_beenden(p_akteur uuid, p_sitzung uuid, p_token_hash bytea)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH beendet AS (
    UPDATE public.sitzung s SET widerrufen_am = now()
    WHERE s.id = p_sitzung AND s.benutzer_id = p_akteur AND s.widerrufen_am IS NULL
      AND (p_token_hash IS NULL OR s.token_hash <> p_token_hash)
      AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM beendet)
$$;

-- Letzte Anmeldungen des Chef-Admins aus dem Protokoll: erfolgreiche (zweiter Faktor, Wiederherstellungscode) und
-- fehlgeschlagene Versuche. Neueste zuerst, höchstens p_limit.
CREATE FUNCTION chef_anmeldungen(p_akteur uuid, p_limit integer)
RETURNS TABLE (id bigint, zeitpunkt timestamptz, aktion text, ergebnis text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id, a.zeitpunkt, a.aktion, coalesce(a.details->>'ergebnis', 'failure')
  FROM public.audit_log a
  WHERE (a.benutzer_id = p_akteur OR a.objekt_id = p_akteur::text)
    AND a.aktion IN ('mfa_success', 'mfa_enrolled', 'recovery_used', 'login_failure', 'mfa_failure', 'recovery_failure')
    AND EXISTS (SELECT 1 FROM public.chef_konto(p_akteur))
  ORDER BY a.zeitpunkt DESC, a.id DESC
  LIMIT least(greatest(p_limit, 1), 50)
$$;

REVOKE ALL ON FUNCTION
  kunde_lizenz_nr_vergeben(),
  kunde_anlegen(uuid, uuid, text, date, timestamptz, text, date, text[]),
  kunden_vertrag(uuid, uuid[]),
  kunde_benutzer_fuer_chef(uuid, uuid),
  chef_sicherheit(uuid),
  chef_sitzungen(uuid, bytea),
  chef_sitzung_beenden(uuid, uuid, bytea),
  chef_anmeldungen(uuid, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  kunde_anlegen(uuid, uuid, text, date, timestamptz, text, date, text[]),
  kunden_vertrag(uuid, uuid[]),
  kunde_benutzer_fuer_chef(uuid, uuid),
  chef_sicherheit(uuid),
  chef_sitzungen(uuid, bytea),
  chef_sitzung_beenden(uuid, uuid, bytea),
  chef_anmeldungen(uuid, integer)
TO stammbuch_app;
