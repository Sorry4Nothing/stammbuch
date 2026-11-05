-- Einzelbuchungen aus CAMT-Dateien mit Zuordnungsstatus. REST = Restposten, den ein Mensch zuordnet.
-- Jede Buchung ist pro Kunde nur einmal vorhanden (UNIQUE auf dem Buchungsschlüssel), auch über
-- Dateigrenzen hinweg: überlappende Auszüge und parallele Uploads erzeugen keine Doppelbuchung.

CREATE TABLE camt_zahlung (
  id               uuid PRIMARY KEY,
  -- Aufsteigende Reihenfolge des Anlegens, Grundlage der Cursor-Paginierung.
  lfd              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kunde_id         uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  import_id        uuid NOT NULL,
  buchungsschluessel text NOT NULL CHECK (buchungsschluessel ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL CHECK (status IN ('MATCHED', 'REST', 'MANUAL')),
  rest_grund       text CHECK (length(rest_grund) <= 50),
  -- Kennung des Postens im Rechnungsmodul; kein Fremdschlüssel, das Modul liegt ausserhalb.
  offener_posten_id text CHECK (length(offener_posten_id) BETWEEN 1 AND 100),
  buchungsdatum    date NOT NULL,
  betrag_rappen    bigint NOT NULL CHECK (betrag_rappen > 0),
  waehrung         text NOT NULL CHECK (waehrung ~ '^[A-Z]{3}$'),
  richtung         text NOT NULL CHECK (richtung IN ('CREDIT', 'DEBIT')),
  storno           boolean NOT NULL,
  -- Normalisierte Buchung (Referenz, Zahlername, IBAN, Mitteilung). Personendaten: nie ins Log (SR-50).
  transaktion      jsonb NOT NULL,
  erstellt_am      timestamptz NOT NULL DEFAULT now(),
  zugeordnet_von   uuid,
  zugeordnet_am    timestamptz,
  UNIQUE (kunde_id, buchungsschluessel),
  FOREIGN KEY (import_id, kunde_id) REFERENCES camt_import (id, kunde_id) ON DELETE CASCADE,
  FOREIGN KEY (zugeordnet_von, kunde_id) REFERENCES benutzer (id, kunde_id),
  CHECK (status = 'REST' OR offener_posten_id IS NOT NULL),
  CHECK ((status = 'MANUAL') = (zugeordnet_am IS NOT NULL))
);

-- Restposten eines Kunden in Reihenfolge (GET /camt/rest).
CREATE INDEX camt_zahlung_rest_idx ON camt_zahlung (kunde_id, lfd) WHERE status = 'REST';
CREATE INDEX camt_zahlung_import_idx ON camt_zahlung (import_id);

ALTER TABLE camt_zahlung ENABLE ROW LEVEL SECURITY;

CREATE POLICY camt_zahlung_lesen ON camt_zahlung
  FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));

CREATE POLICY camt_zahlung_anlegen ON camt_zahlung
  FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

CREATE POLICY camt_zahlung_zuordnen ON camt_zahlung
  FOR UPDATE TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Die Buchung selbst bleibt unveränderlich; nur die Zuordnung ändert sich. Kein DELETE.
GRANT SELECT, INSERT ON camt_zahlung TO stammbuch_app;
GRANT UPDATE (status, rest_grund, offener_posten_id, zugeordnet_von, zugeordnet_am)
  ON camt_zahlung TO stammbuch_app;
