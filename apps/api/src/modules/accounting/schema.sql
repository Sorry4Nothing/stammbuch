-- ENTWURF: Datenbankschema der Debitorenbuchhaltung (PostgreSQL 16+), Issue #8.
-- Noch keine Migration. Ein Integrations-Schritt übernimmt dies später nach
-- packages/db/migrations und passt Tabellennamen, Mandanten- und Personenverweise an.
--
-- Zweck: Die Unveränderbarkeit und die Soll=Haben-Regel gelten in der Datenbank, nicht nur im
-- Anwendungscode (GeBüV; Art. 958f OR: 10 Jahre Aufbewahrung ab Ende des Geschäftsjahres).
-- Die Anwendung (service.ts) prüft dieselben Regeln vorab; die Trigger sind die zweite Linie.
--
-- Rollen (Defense in depth, Trigger allein genügen nicht, weil der Tabelleneigentümer sie
-- entfernen könnte):
--   stammbuch_owner : Eigentümer, führt Migrationen aus. Nie die Laufzeitverbindung der API.
--   stammbuch_app   : Laufzeitrolle der API. Nur SELECT/INSERT, nie UPDATE/DELETE/TRUNCATE
--                     auf den anhängenden Tabellen (siehe GRANT-Abschnitt am Ende).
-- Mandant: Jede Verbindung setzt pro Transaktion `SET LOCAL app.tenant_id = '<uuid>'`.
-- Row-Level-Security erzwingt die Trennung (projektplan.md, Abschnitt 8: getrennte Kunden).

-- ---------------------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------------------

create or replace function acc_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Verweigert jede Änderung. Wird an alle anhängenden Tabellen gehängt.
create or replace function acc_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Tabelle % ist nur anhängend: % ist nicht erlaubt (Storno per Gegenbuchung)',
    tg_table_name, tg_op
    using errcode = 'integrity_constraint_violation';
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Kontenplan (je Mandant). Konten werden nie gelöscht; Name und Aktiv-Flag sind änderbar.
-- ---------------------------------------------------------------------------------------

create table acc_account (
  tenant_id uuid not null,
  code      text not null check (code ~ '^[0-9]{4,6}$'),
  name      text not null check (length(name) between 2 and 100),
  type      text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  active    boolean not null default true,
  primary key (tenant_id, code)
);

create or replace function acc_account_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Konten werden nie gelöscht, nur deaktiviert' using errcode = 'integrity_constraint_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.code <> old.code or new.type <> old.type then
    raise exception 'Kontonummer und Kontoart sind unveränderlich' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger acc_account_guard before update or delete on acc_account
  for each row execute function acc_account_guard();
create trigger acc_account_no_truncate before truncate on acc_account
  for each statement execute function acc_forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- Journal: Buchung (Kopf) und Zeilen. Nur anhängend.
-- ---------------------------------------------------------------------------------------

create table acc_entry (
  id              uuid primary key,
  tenant_id       uuid not null,
  number          bigint not null check (number >= 1),     -- lückenlos je Mandant
  booking_date    date not null,
  kind            text not null check (kind in ('manual', 'invoice', 'credit_note', 'payment', 'reversal')),
  description     text not null check (length(description) between 1 and 200),
  reversal_of     uuid references acc_entry (id),
  created_at      timestamptz not null,
  created_by      text not null,
  retention_until date not null,                           -- 31.12. des Buchungsjahres + 10 Jahre
  prev_hash       char(64) not null,                       -- Hash der Vorgängerbuchung (Kette)
  hash            char(64) not null,                       -- sha256 über Inhalt + prev_hash, berechnet in der Anwendung
  xid             xid8 not null default pg_current_xact_id(),
  unique (tenant_id, number),
  unique (tenant_id, id),
  check ((kind = 'reversal') = (reversal_of is not null)),
  check (retention_until = make_date(extract(year from booking_date)::int + 10, 12, 31))
);
-- Höchstens eine Gegenbuchung je Buchung.
create unique index acc_entry_one_reversal on acc_entry (tenant_id, reversal_of) where reversal_of is not null;
create index acc_entry_date on acc_entry (tenant_id, booking_date);

create table acc_entry_line (
  entry_id     uuid not null references acc_entry (id),
  tenant_id    uuid not null,
  line_no      smallint not null check (line_no >= 1),
  account_code text not null,
  side         text not null check (side in ('debit', 'credit')),
  amount       bigint not null check (amount > 0 and amount <= 1000000000000), -- ganze Rappen
  person_id    text check (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  primary key (entry_id, line_no),
  foreign key (tenant_id, account_code) references acc_account (tenant_id, code),
  -- Debitoren-Sammelkonto 1100: immer mit Person; alle anderen Konten: nie.
  check ((account_code = '1100') = (person_id is not null))
);
create index acc_line_account on acc_entry_line (tenant_id, account_code);
create index acc_line_person on acc_entry_line (tenant_id, person_id) where person_id is not null;

-- Belegnummer lückenlos und Hash-Kette: serialisiert je Mandant über einen Advisory-Lock.
-- Gesperrte Periode: keine neue Buchung mit Datum in einer abgeschlossenen Periode.
create or replace function acc_entry_before_insert() returns trigger
language plpgsql as $$
declare
  last_row acc_entry;
  p_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 8));

  select * into last_row from acc_entry
   where tenant_id = new.tenant_id order by number desc limit 1;
  if new.number <> coalesce(last_row.number, 0) + 1 then
    raise exception 'Belegnummer % ist nicht die nächste (erwartet %)', new.number, coalesce(last_row.number, 0) + 1
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.prev_hash <> coalesce(last_row.hash, repeat('0', 64)) then
    raise exception 'Hash-Kette unterbrochen bei Beleg %', new.number
      using errcode = 'integrity_constraint_violation';
  end if;

  select status into p_status from acc_period_event
   where tenant_id = new.tenant_id and period = to_char(new.booking_date, 'YYYY-MM')
   order by seq desc limit 1;
  if p_status = 'closed' then
    raise exception 'Periode % ist abgeschlossen', to_char(new.booking_date, 'YYYY-MM')
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

-- Zeilen dürfen nur in derselben Transaktion wie ihre Buchung entstehen. Damit kann niemand
-- später eine Zeile an eine bestehende Buchung hängen.
create or replace function acc_line_before_insert() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from acc_entry e
                  where e.id = new.entry_id and e.tenant_id = new.tenant_id
                    and e.xid = pg_current_xact_id()) then
    raise exception 'Zeilen nur in der Transaktion der Buchung erlaubt'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

-- Soll = Haben, mindestens zwei Zeilen: geprüft beim Commit (deferred), wenn alle Zeilen da sind.
create or replace function acc_entry_check_balanced() returns trigger
language plpgsql as $$
declare
  d bigint; c bigint; n int;
begin
  select coalesce(sum(amount) filter (where side = 'debit'), 0),
         coalesce(sum(amount) filter (where side = 'credit'), 0),
         count(*)
    into d, c, n
    from acc_entry_line where entry_id = new.id;
  if n < 2 or d <> c then
    raise exception 'Buchung % ist nicht ausgeglichen (Soll %, Haben %, % Zeilen)', new.number, d, c, n
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;

create trigger acc_entry_before_insert before insert on acc_entry
  for each row execute function acc_entry_before_insert();
create constraint trigger acc_entry_balanced after insert on acc_entry
  deferrable initially deferred for each row execute function acc_entry_check_balanced();
create trigger acc_line_before_insert before insert on acc_entry_line
  for each row execute function acc_line_before_insert();

create trigger acc_entry_immutable before update or delete on acc_entry
  for each row execute function acc_forbid_mutation();
create trigger acc_line_immutable before update or delete on acc_entry_line
  for each row execute function acc_forbid_mutation();
create trigger acc_entry_no_truncate before truncate on acc_entry
  for each statement execute function acc_forbid_mutation();
create trigger acc_line_no_truncate before truncate on acc_entry_line
  for each statement execute function acc_forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- Offene Posten, Guthaben (Zahlung/Gutschrift), Zuordnungen. Nur anhängend.
-- Der Zustand (offen, bezahlt, storniert) wird aus den Zuordnungen und der Gegenbuchung
-- abgeleitet, nie als veränderbares Feld gespeichert.
-- ---------------------------------------------------------------------------------------

create table acc_open_item (
  id            uuid primary key,
  tenant_id     uuid not null,
  person_id     text not null check (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  reference     text not null check (length(reference) between 1 and 60),
  document_date date not null,
  due_date      date not null check (due_date >= document_date),
  amount        bigint not null check (amount > 0 and amount <= 1000000000000),
  entry_id      uuid not null unique references acc_entry (id),
  created_at    timestamptz not null,
  unique (tenant_id, id)
);
create index acc_open_item_person on acc_open_item (tenant_id, person_id, due_date);

create table acc_credit (
  id         uuid primary key,
  tenant_id  uuid not null,
  kind       text not null check (kind in ('payment', 'credit_note')),
  person_id  text not null check (person_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  reference  text not null check (length(reference) between 1 and 60),
  value_date date not null,
  amount     bigint not null check (amount > 0 and amount <= 1000000000000),
  entry_id   uuid not null unique references acc_entry (id),
  created_at timestamptz not null,
  unique (tenant_id, id)
);
create index acc_credit_person on acc_credit (tenant_id, person_id);

create table acc_allocation (
  id           uuid primary key,
  tenant_id    uuid not null,
  credit_id    uuid not null references acc_credit (id),
  open_item_id uuid not null references acc_open_item (id),
  amount       bigint not null check (amount <> 0 and abs(amount) <= 1000000000000), -- negativ = Aufhebung
  reversal_of  uuid unique references acc_allocation (id),                           -- höchstens eine Aufhebung
  created_at   timestamptz not null,
  created_by   text not null,
  check ((amount < 0) = (reversal_of is not null))
);
create index acc_allocation_credit on acc_allocation (credit_id);
create index acc_allocation_item on acc_allocation (open_item_id);

-- Zuordnungen bleiben je Guthaben und je Posten zwischen 0 und dem Betrag, nur gleiche Person,
-- nie auf stornierte Belege. Zeilensperre auf Guthaben und Posten serialisiert parallele Zuordnungen.
create or replace function acc_allocation_check() returns trigger
language plpgsql as $$
declare
  cr acc_credit; oi acc_open_item;
  credit_sum bigint; item_sum bigint;
begin
  select * into cr from acc_credit where id = new.credit_id and tenant_id = new.tenant_id for update;
  select * into oi from acc_open_item where id = new.open_item_id and tenant_id = new.tenant_id for update;
  if cr.id is null or oi.id is null then
    raise exception 'Guthaben oder Posten gehört nicht zum Mandanten' using errcode = 'integrity_constraint_violation';
  end if;
  if cr.person_id <> oi.person_id then
    raise exception 'Guthaben und Posten gehören zu verschiedenen Personen' using errcode = 'integrity_constraint_violation';
  end if;
  if new.amount > 0 and (
       exists (select 1 from acc_entry where reversal_of = cr.entry_id)
    or exists (select 1 from acc_entry where reversal_of = oi.entry_id)) then
    raise exception 'Zuordnung auf stornierten Beleg' using errcode = 'integrity_constraint_violation';
  end if;
  select coalesce(sum(amount), 0) + new.amount into credit_sum from acc_allocation where credit_id = cr.id;
  select coalesce(sum(amount), 0) + new.amount into item_sum   from acc_allocation where open_item_id = oi.id;
  if credit_sum not between 0 and cr.amount or item_sum not between 0 and oi.amount then
    raise exception 'Zuordnung überschreitet Guthaben oder offenen Rest' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger acc_allocation_check before insert on acc_allocation
  for each row execute function acc_allocation_check();

-- Ein Beleg mit aktiver Zuordnung kann nicht storniert werden (zuerst Zuordnung aufheben).
create or replace function acc_reversal_requires_free_documents() returns trigger
language plpgsql as $$
begin
  if new.reversal_of is not null and (
       exists (select 1 from acc_open_item oi where oi.entry_id = new.reversal_of
                 and (select coalesce(sum(amount), 0) from acc_allocation where open_item_id = oi.id) <> 0)
    or exists (select 1 from acc_credit cr where cr.entry_id = new.reversal_of
                 and (select coalesce(sum(amount), 0) from acc_allocation where credit_id = cr.id) <> 0)) then
    raise exception 'Beleg hat aktive Zuordnungen; zuerst aufheben' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger acc_reversal_requires_free_documents before insert on acc_entry
  for each row execute function acc_reversal_requires_free_documents();

create trigger acc_open_item_immutable before update or delete on acc_open_item
  for each row execute function acc_forbid_mutation();
create trigger acc_credit_immutable before update or delete on acc_credit
  for each row execute function acc_forbid_mutation();
create trigger acc_allocation_immutable before update or delete on acc_allocation
  for each row execute function acc_forbid_mutation();
create trigger acc_open_item_no_truncate before truncate on acc_open_item
  for each statement execute function acc_forbid_mutation();
create trigger acc_credit_no_truncate before truncate on acc_credit
  for each statement execute function acc_forbid_mutation();
create trigger acc_allocation_no_truncate before truncate on acc_allocation
  for each statement execute function acc_forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- Perioden (Monat): Ereignisse, der letzte gilt. Wiederöffnen ist ein neues Ereignis mit Grund.
-- ---------------------------------------------------------------------------------------

create table acc_period_event (
  seq       bigint generated always as identity primary key,
  tenant_id uuid not null,
  period    text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status    text not null check (status in ('closed', 'open')),
  at        timestamptz not null,
  actor     text not null,
  reason    text check (length(reason) between 3 and 150),
  check ((status = 'open') = (reason is not null))
);
create index acc_period_event_lookup on acc_period_event (tenant_id, period, seq desc);
create trigger acc_period_event_immutable before update or delete on acc_period_event
  for each row execute function acc_forbid_mutation();
create trigger acc_period_event_no_truncate before truncate on acc_period_event
  for each statement execute function acc_forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- Protokoll (Audit) und Idempotenz
-- ---------------------------------------------------------------------------------------

create table acc_audit (
  id          uuid primary key,
  tenant_id   uuid not null,
  at          timestamptz not null,
  actor       text not null,
  action      text not null,
  object_type text not null,
  object_id   text not null,
  detail      jsonb not null default '{}'::jsonb  -- nur IDs und Beträge, keine Freitexte (SR-50)
);
create index acc_audit_time on acc_audit (tenant_id, at);
create trigger acc_audit_immutable before update or delete on acc_audit
  for each row execute function acc_forbid_mutation();
create trigger acc_audit_no_truncate before truncate on acc_audit
  for each statement execute function acc_forbid_mutation();

create table acc_idempotency (
  tenant_id    uuid not null,
  key          text not null check (key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  request_hash char(64) not null,
  result       jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, key)
);
create trigger acc_idempotency_immutable before update or delete on acc_idempotency
  for each row execute function acc_forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- Aufbewahrung (GeBüV, Art. 958f OR)
-- ---------------------------------------------------------------------------------------
-- Löschen ist für die Laufzeitrolle und per Trigger ausgeschlossen. Nach Ablauf von
-- `retention_until` darf ein Mandant bereinigt werden, aber nur in einem eigenen, geprüften
-- Verfahren: Export/Archivierung, dann Ausführung durch stammbuch_owner mit vorher
-- deaktivierten Triggern in einer dokumentierten Wartung. Das ist keine Anwendungsfunktion.
-- Offen mit Treuhänder/Anwalt zu klären (projektplan.md, Abschnitt 8): ob Zeitstempel oder
-- Signaturen nötig sind. Die Hash-Kette (hash/prev_hash) ist die technische Grundlage dafür;
-- ein regelmässiger Prüflauf (AccountingService.verifyIntegrity) vergleicht sie mit dem Inhalt.

-- ---------------------------------------------------------------------------------------
-- Mandantentrennung (Row-Level-Security) und Rechte
-- ---------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['acc_account', 'acc_entry', 'acc_entry_line', 'acc_open_item', 'acc_credit',
                           'acc_allocation', 'acc_period_event', 'acc_audit', 'acc_idempotency'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = acc_current_tenant())
                    with check (tenant_id = acc_current_tenant())', t);
  end loop;
end $$;

-- Laufzeitrolle: anhängend. Nur das Konto darf Name/Aktiv-Flag ändern.
-- grant select, insert on acc_entry, acc_entry_line, acc_open_item, acc_credit, acc_allocation,
--   acc_period_event, acc_audit, acc_idempotency to stammbuch_app;
-- grant select, insert, update (name, active) on acc_account to stammbuch_app;
-- grant usage on sequence acc_period_event_seq_seq to stammbuch_app;
-- revoke update, delete, truncate on all tables in schema public from stammbuch_app;
