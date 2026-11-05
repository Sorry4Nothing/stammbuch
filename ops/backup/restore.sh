#!/usr/bin/env bash
# Spielt eine Sicherung in eine NEUE, leere Datenbank zurück.
#
#   AGE_IDENTITY=/pfad/zum/privaten-schluessel.txt ops/backup/restore.sh <datei.dump.age> <neue_datenbank>
#
# Das Skript überschreibt nie eine bestehende Datenbank: createdb schlägt fehl, wenn der Name vergeben
# ist. Für einen Ernstfall wird in eine neue Datenbank zurückgespielt, geprüft und danach die
# Anwendung umgestellt (siehe docs/betriebsanleitung.md, Abschnitt Wiederherstellung).
#
# Verbindung über libpq-Variablen (PGHOST, PGUSER, PGSSLMODE, PGPASSFILE). Rollen der Anwendung
# (Login-Rolle der API ohne BYPASSRLS) müssen auf dem Zielserver vorher existieren, pg_dump sichert sie nicht.
set -Eeuo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$here/lib.sh"

(($# == 2)) || die "Aufruf: restore.sh <datei.dump.age> <neue_datenbank>"
file=$1
target=$2
: "${AGE_IDENTITY:?AGE_IDENTITY fehlt (Pfad zur Datei mit dem privaten age-Schlüssel)}"
[[ -r $file ]] || die "Sicherung nicht lesbar: $file"
[[ -r $AGE_IDENTITY ]] || die "Schlüsseldatei nicht lesbar: $AGE_IDENTITY"
# Der Name wird an createdb und pg_restore übergeben: nur einfache Bezeichner zulassen (SR-25).
[[ $target =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "Ungültiger Datenbankname: $target"
require age pg_restore createdb sha256sum

if [[ -r $file.sha256 ]]; then
  (cd "$(dirname "$file")" && sha256sum --check --status -- "$(basename "$file").sha256") || die "Prüfsumme stimmt nicht"
  log "Prüfsumme in Ordnung"
else
  log "WARNUNG: keine Prüfsummendatei neben der Sicherung"
fi

createdb -- "$target"
log "Spiele $file in Datenbank $target zurück"
if ! age --decrypt --identity "$AGE_IDENTITY" -- "$file" | pg_restore --no-owner --no-privileges --exit-on-error --dbname "$target"; then
  die "Wiederherstellung fehlgeschlagen. Die halbe Datenbank $target bleibt zur Untersuchung stehen (danach: dropdb $target)"
fi
log "Fertig: Datenbank $target ist wiederhergestellt. Jetzt prüfen, bevor die Anwendung umgestellt wird."
