#!/usr/bin/env bash
# Restore-Test: spielt die neueste Sicherung in eine Wegwerf-Datenbank zurück, prüft sie und löscht sie.
# Läuft NICHT auf dem Produktionsserver, sondern auf einem vertrauenswürdigen Rechner mit dem privaten
# Schlüssel und einem Test-PostgreSQL (zum Beispiel `docker compose up -d stammbuch-db`). Quartalsweise
# und nach jeder Änderung am Backup-Verfahren. Ein Backup ohne bestandenen Restore-Test gilt als nicht vorhanden.
#
#   AGE_IDENTITY=... PGHOST=... PGUSER=... ops/backup/restore-test.sh <sicherung.dump.age>
#
# Optional RESTORE_TEST_SQL=datei.sql: eigene Prüfabfragen. Jede Abfrage muss mit Exit-Code 0 laufen
# (zum Beispiel `SELECT 1 / (SELECT count(*) FROM tenants)`, das bei leerer Tabelle fehlschlägt).
set -Eeuo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$here/lib.sh"

(($# == 1)) || die "Aufruf: restore-test.sh <sicherung.dump.age>"
require psql dropdb
db="stammbuch_restore_test_$(date -u +%Y%m%d%H%M%S)"
trap 'dropdb --if-exists -- "$db" >/dev/null 2>&1 || true' EXIT

"$here/restore.sh" "$1" "$db"

tables=$(psql --no-psqlrc --quiet --tuples-only --no-align --dbname "$db" \
  --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
((tables > 0)) || die "Restore-Test fehlgeschlagen: keine Tabellen im Schema public"
log "Tabellen im Schema public: $tables"

if [[ -n ${RESTORE_TEST_SQL:-} ]]; then
  [[ -r $RESTORE_TEST_SQL ]] || die "Prüfdatei nicht lesbar: $RESTORE_TEST_SQL"
  psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname "$db" --file "$RESTORE_TEST_SQL" >/dev/null ||
    die "Restore-Test fehlgeschlagen: Prüfabfragen"
fi
log "Restore-Test bestanden: $1"
