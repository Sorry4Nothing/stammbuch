-- Offene Selbstregistrierungen (Double-Opt-in). Gespeichert wird nur der SHA-256-Hash (hex) des
-- Tokens, nie das Token selbst (SR-30). Die Daten sind bereits validiert und verfallen mit dem Token.

CREATE TABLE registrierung_offen (
  token_hash text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kunde_id   uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  art        text        NOT NULL CHECK (art IN ('person', 'firma')),
  daten      jsonb       NOT NULL,
  ablauf_am  timestamptz NOT NULL
);

CREATE INDEX registrierung_offen_ablauf ON registrierung_offen (kunde_id, ablauf_am);

ALTER TABLE registrierung_offen ENABLE ROW LEVEL SECURITY;

CREATE POLICY registrierung_offen_eigener_kunde ON registrierung_offen
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Anlegen (Mandant bekannt) und Aufräumen abgelaufener Einträge des eigenen Kunden.
GRANT SELECT, INSERT, DELETE ON registrierung_offen TO stammbuch_app;

-- Einlösen: einmalig und atomar (DELETE ... RETURNING). Läuft als Eigentümer, weil erst der Token
-- den Mandanten liefert. Wer den Token (256 Bit, zufällig) nicht kennt, findet nichts.
CREATE FUNCTION registrierung_einloesen(p_token_hash text)
RETURNS TABLE (kunde_id uuid, art text, daten jsonb, ablauf_am timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  DELETE FROM public.registrierung_offen r WHERE r.token_hash = p_token_hash
  RETURNING r.kunde_id, r.art, r.daten, r.ablauf_am
$$;

REVOKE ALL ON FUNCTION registrierung_einloesen(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registrierung_einloesen(text) TO stammbuch_app;
