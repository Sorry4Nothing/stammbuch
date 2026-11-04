-- Hilfsfunktionen der Debitorenbuchhaltung (Issue #8).
-- Die Buchhaltung ist nur anhängend (GeBüV, Art. 958f OR): Korrekturen sind Gegenbuchungen, nie UPDATE oder DELETE.
-- Aufbewahrung: Buchungen und Belege werden nicht gelöscht, auch nicht mit dem Kunden. Die Fremdschlüssel auf
-- kunde sind deshalb RESTRICT statt CASCADE. Eine Bereinigung nach Ablauf von aufbewahren_bis ist ein eigenes,
-- geprüftes Wartungsverfahren des Eigentümers (Export, dann Löschen mit vorübergehend deaktivierten Triggern),
-- keine Anwendungsfunktion.

-- Serialisiert alle Schreibvorgänge der Buchhaltung eines Kunden bis zum Transaktionsende. Das hält die
-- Belegnummern lückenlos und die Hash-Kette eindeutig, auch bei parallelen Anfragen. Die Anwendung nimmt
-- die Sperre zu Beginn jeder Transaktion; die Trigger nehmen sie nochmals (die Sperre ist wiedereintrittsfähig).
CREATE FUNCTION buchhaltung_sperre(p_kunde_id uuid) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog
AS $$ SELECT pg_advisory_xact_lock(hashtextextended('buchhaltung:' || p_kunde_id::text, 0)) $$;

CREATE FUNCTION buchhaltung_nur_anhaengen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Tabelle % ist nur anhängend: % ist nicht erlaubt (Korrektur per Gegenbuchung)', tg_table_name, tg_op
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

REVOKE ALL ON FUNCTION buchhaltung_sperre(uuid), buchhaltung_nur_anhaengen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buchhaltung_sperre(uuid), buchhaltung_nur_anhaengen() TO stammbuch_app;
