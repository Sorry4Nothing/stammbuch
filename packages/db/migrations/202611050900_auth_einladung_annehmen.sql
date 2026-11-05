-- Einladung einlösen (Issue #56): das Token führt erst zum Kunden, und die Anwendungsrolle darf weder `aktiv` noch
-- `status` eines Benutzers setzen. Deshalb zwei schmale SECURITY-DEFINER-Funktionen mit festen Spalten.
--
-- Eine Einladung gilt, solange sie nicht eingelöst und nicht abgelaufen ist, der Kunde aktiv ist und (bei einem
-- vorhandenen Benutzer-Eintrag) der Benutzer noch eingeladen ist. Alles andere liefert keine Zeile, ohne zu sagen warum.

-- Prüfen, ohne einzulösen: liefert Adresse und Kunde der gültigen Einladung (für die Passwortregel «nicht Teil der
-- E-Mail» und damit das Einlösen im Mandanten der Einladung als eine Transaktion mit dem Protokolleintrag laufen kann).
CREATE FUNCTION einladung_pruefen(p_token_hash bytea, p_jetzt timestamptz)
RETURNS TABLE (email text, kunde_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.email, e.kunde_id
  FROM public.einladung e
  JOIN public.kunde k ON k.id = e.kunde_id AND k.status = 'active'
  WHERE e.token_hash = p_token_hash AND e.eingeloest_am IS NULL AND e.laeuft_ab_am > p_jetzt
    AND CASE WHEN e.benutzer_id IS NULL
      THEN NOT EXISTS (SELECT 1 FROM public.benutzer b WHERE b.email = e.email)
      ELSE EXISTS (
        SELECT 1 FROM public.benutzer b
        WHERE b.id = e.benutzer_id AND b.kunde_id = e.kunde_id AND b.rolle = 'user' AND b.status = 'invited')
    END
$$;

-- Einlösen, Passwort setzen und Benutzer aktivieren (oder den ersten Admin eines Kunden anlegen) in EINER Transaktion:
-- scheitert ein Schritt, bleibt die Einladung unverbraucht. Die Zeile der Einladung ist bis zum Ende gesperrt, ein
-- zweiter Aufruf mit demselben Token findet sie danach als eingelöst vor. Nie aktiviert wird ein Konto, das schon aktiv
-- ist (kein Weg, ein fremdes Passwort zu überschreiben), und nie ein Chef-Admin.
CREATE FUNCTION einladung_annehmen(p_token_hash bytea, p_jetzt timestamptz, p_passwort_hash text)
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
    -- Erster Admin eines Kunden: noch kein Benutzer-Eintrag. Der Name ist der Teil der Adresse vor dem @.
    BEGIN
      INSERT INTO public.benutzer (kunde_id, email, name, passwort_hash, aktiv, kunden_rolle, status)
      VALUES (inv.kunde_id, inv.email, left(coalesce(nullif(split_part(inv.email, '@', 1), ''), inv.email), 200),
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

REVOKE ALL ON FUNCTION einladung_pruefen(bytea, timestamptz), einladung_annehmen(bytea, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION einladung_pruefen(bytea, timestamptz), einladung_annehmen(bytea, timestamptz, text)
TO stammbuch_app;
