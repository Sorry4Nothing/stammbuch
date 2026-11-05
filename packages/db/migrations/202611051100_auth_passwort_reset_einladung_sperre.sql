-- Passwort vergessen (Issue #65) sowie Name und Sperre pro Einladung (Issue #66).
--
-- 1. passwort_reset: Einmal-Token für das Zurücksetzen. Wie bei einladung führt erst das Token zum Kunden; deshalb nur
--    schmale SECURITY-DEFINER-Funktionen. Anders als bei einladung gibt es für die Anwendungsrolle weder Richtlinie noch
--    Tabellenrechte: sie darf Tokens weder auflisten noch ändern (RLS ist aktiv). Gespeichert wird nur der SHA-256-Hash
--    (SR-30).
-- 2. einladung: optionaler Name des ersten Admins (bisher der Teil der Adresse vor dem @) und ein Fehlversuchszähler;
--    ab 10 Fehlversuchen ist die Einladung gesperrt und muss neu ausgelöst werden.

CREATE TABLE passwort_reset (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id   uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  erstellt_am   timestamptz NOT NULL,
  laeuft_ab_am  timestamptz NOT NULL,
  -- Eingelöst oder durch ein neueres Token ersetzt.
  verbraucht_am timestamptz,
  CHECK (laeuft_ab_am > erstellt_am),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX passwort_reset_benutzer_idx ON passwort_reset (benutzer_id, erstellt_am DESC);
CREATE INDEX passwort_reset_erstellt_idx ON passwort_reset (erstellt_am);

ALTER TABLE passwort_reset ENABLE ROW LEVEL SECURITY;

ALTER TABLE einladung
  ADD COLUMN name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  ADD COLUMN fehlversuche integer NOT NULL DEFAULT 0 CHECK (fehlversuche >= 0);

-- Token anlegen für ein aktives Konto eines aktiven Kunden. Keine Zeile heisst: unbekannte Adresse, Konto nicht
-- aktiv oder Limit erreicht (höchstens 3 Tokens pro Stunde und Konto), ohne zu sagen was davon (SR-05). Ein neues
-- Token macht ältere ungültig, es gilt immer nur das jüngste. Die Zeile des Benutzers ist gesperrt, damit gleichzeitige
-- Anfragen das Limit nicht umgehen.
CREATE FUNCTION passwort_reset_anlegen(p_email text, p_token_hash bytea, p_jetzt timestamptz, p_laeuft_ab timestamptz)
RETURNS TABLE (benutzer_id uuid, kunde_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  uid uuid;
  kid uuid;
BEGIN
  SELECT b.id, b.kunde_id INTO uid, kid
  FROM public.benutzer b
  JOIN public.kunde k ON k.id = b.kunde_id AND k.status = 'active'
  WHERE b.email = lower(p_email) AND b.aktiv AND b.status = 'active'
  FOR UPDATE OF b;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Aufräumen: Tokens, die längst abgelaufen sind, braucht niemand mehr (das Limit sieht nur die letzte Stunde).
  DELETE FROM public.passwort_reset r WHERE r.erstellt_am < p_jetzt - interval '1 day';
  IF (SELECT count(*) FROM public.passwort_reset r
      WHERE r.benutzer_id = uid AND r.erstellt_am > p_jetzt - interval '1 hour') >= 3 THEN
    RETURN;
  END IF;

  UPDATE public.passwort_reset r SET verbraucht_am = p_jetzt WHERE r.benutzer_id = uid AND r.verbraucht_am IS NULL;
  INSERT INTO public.passwort_reset (kunde_id, benutzer_id, token_hash, erstellt_am, laeuft_ab_am)
  VALUES (kid, uid, p_token_hash, p_jetzt, p_laeuft_ab);
  RETURN QUERY SELECT uid, kid;
END
$$;

-- Prüfen, ohne einzulösen: Adresse (für die Passwortregel «nicht Teil der E-Mail») und Mandant (für die Transaktion).
CREATE FUNCTION passwort_reset_pruefen(p_token_hash bytea, p_jetzt timestamptz)
RETURNS TABLE (benutzer_id uuid, kunde_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.benutzer_id, r.kunde_id, b.email
  FROM public.passwort_reset r
  JOIN public.benutzer b ON b.id = r.benutzer_id AND b.kunde_id = r.kunde_id AND b.aktiv AND b.status = 'active'
  JOIN public.kunde k ON k.id = r.kunde_id AND k.status = 'active'
  WHERE r.token_hash = p_token_hash AND r.verbraucht_am IS NULL AND r.laeuft_ab_am > p_jetzt
$$;

-- Einlösen: genau einmal (ein einziges bedingtes UPDATE), gleichzeitige Aufrufe mit demselben Token: einer gewinnt.
CREATE FUNCTION passwort_reset_einloesen(p_token_hash bytea, p_jetzt timestamptz)
RETURNS TABLE (benutzer_id uuid, kunde_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.passwort_reset r SET verbraucht_am = p_jetzt
  WHERE r.token_hash = p_token_hash AND r.verbraucht_am IS NULL AND r.laeuft_ab_am > p_jetzt
    AND EXISTS (
      SELECT 1 FROM public.benutzer b
      JOIN public.kunde k ON k.id = b.kunde_id AND k.status = 'active'
      WHERE b.id = r.benutzer_id AND b.kunde_id = r.kunde_id AND b.aktiv AND b.status = 'active')
  RETURNING r.benutzer_id, r.kunde_id
$$;

-- Fehlversuch pro Einladung zählen (ein UPDATE, kein Lesen-Ändern-Schreiben). Nur für unverbrauchte Einladungen.
CREATE FUNCTION einladung_fehlversuch(p_token_hash bytea) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.einladung e SET fehlversuche = e.fehlversuche + 1
  WHERE e.token_hash = p_token_hash AND e.eingeloest_am IS NULL
$$;

-- Wie 202611050900, dazu: gesperrte Einladungen (ab 10 Fehlversuchen) gelten nicht mehr; Name aus der Einladung.
CREATE OR REPLACE FUNCTION einladung_pruefen(p_token_hash bytea, p_jetzt timestamptz)
RETURNS TABLE (email text, kunde_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.email, e.kunde_id
  FROM public.einladung e
  JOIN public.kunde k ON k.id = e.kunde_id AND k.status = 'active'
  WHERE e.token_hash = p_token_hash AND e.eingeloest_am IS NULL AND e.laeuft_ab_am > p_jetzt
    AND e.fehlversuche < 10
    AND CASE WHEN e.benutzer_id IS NULL
      THEN NOT EXISTS (SELECT 1 FROM public.benutzer b WHERE b.email = e.email)
      ELSE EXISTS (
        SELECT 1 FROM public.benutzer b
        WHERE b.id = e.benutzer_id AND b.kunde_id = e.kunde_id AND b.rolle = 'user' AND b.status = 'invited')
    END
$$;

CREATE OR REPLACE FUNCTION einladung_annehmen(p_token_hash bytea, p_jetzt timestamptz, p_passwort_hash text)
RETURNS TABLE (benutzer_id uuid, kunde_id uuid, rolle text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  inv public.einladung%ROWTYPE;
  uid uuid;
BEGIN
  SELECT e.* INTO inv
  FROM public.einladung e
  JOIN public.kunde k ON k.id = e.kunde_id AND k.status = 'active'
  WHERE e.token_hash = p_token_hash AND e.eingeloest_am IS NULL AND e.laeuft_ab_am > p_jetzt
    AND e.fehlversuche < 10
  FOR UPDATE OF e;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF inv.benutzer_id IS NOT NULL THEN
    UPDATE public.benutzer b
    SET passwort_hash = p_passwort_hash, aktiv = true, status = 'active', kunden_rolle = inv.rolle
    WHERE b.id = inv.benutzer_id AND b.kunde_id = inv.kunde_id AND b.rolle = 'user' AND b.status = 'invited'
    RETURNING b.id INTO uid;
  ELSE
    -- Erster Admin eines Kunden: noch kein Benutzer-Eintrag. Name aus der Einladung, sonst der Teil der Adresse vor dem @.
    BEGIN
      INSERT INTO public.benutzer (kunde_id, email, name, passwort_hash, aktiv, kunden_rolle, status)
      VALUES (inv.kunde_id, inv.email,
              left(coalesce(inv.name, nullif(split_part(inv.email, '@', 1), ''), inv.email), 200),
              p_passwort_hash, true, inv.rolle, 'active')
      RETURNING id INTO uid;
    EXCEPTION WHEN unique_violation THEN
      uid := NULL; -- die Adresse gehört schon einem Konto
    END;
  END IF;

  IF uid IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.einladung e SET eingeloest_am = p_jetzt WHERE e.id = inv.id;
  RETURN QUERY SELECT uid, inv.kunde_id, inv.rolle;
END
$$;

REVOKE ALL ON FUNCTION
  passwort_reset_anlegen(text, bytea, timestamptz, timestamptz), passwort_reset_pruefen(bytea, timestamptz),
  passwort_reset_einloesen(bytea, timestamptz), einladung_fehlversuch(bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  passwort_reset_anlegen(text, bytea, timestamptz, timestamptz), passwort_reset_pruefen(bytea, timestamptz),
  passwort_reset_einloesen(bytea, timestamptz), einladung_fehlversuch(bytea)
TO stammbuch_app;
