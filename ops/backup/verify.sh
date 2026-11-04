#!/usr/bin/env bash
# Prüft auf dem Server, ob die Sicherungen in Ordnung wirken. Braucht den privaten Schlüssel nicht.
# Exit-Code 0: alles gut. Sonst ein Fehlertext und Exit-Code 1 (vom Timer als fehlgeschlagen gemeldet).
#
# Geprüft wird: letzte erfolgreiche Sicherung nicht älter als MAX_AGE_HOURS, Prüfsumme der neuesten
# Datei stimmt, Mindestgrösse, und die neueste Datei ist nicht auffällig kleiner als die davor.
# Ob sich eine Sicherung wirklich zurückspielen lässt, zeigt nur restore-test.sh.
set -Eeuo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$here/lib.sh"
load_env
MAX_AGE_HOURS=${MAX_AGE_HOURS:-26}
MIN_BYTES=${MIN_BYTES:-1024}
require sha256sum

[[ -r $BACKUP_DIR/last-success ]] || die "Noch nie eine erfolgreiche Sicherung"
age_s=$(($(date +%s) - $(<"$BACKUP_DIR/last-success")))
((age_s <= MAX_AGE_HOURS * 3600)) || die "Letzte erfolgreiche Sicherung ist $((age_s / 3600)) Stunden alt (Grenze: $MAX_AGE_HOURS)"

mapfile -t files < <(find "$BACKUP_DIR/daily" -maxdepth 1 -type f -name 'stammbuch-*.dump.age' -print | sort -r | head -n 2)
((${#files[@]} >= 1)) || die "Keine Sicherung im Ordner daily"
newest=${files[0]}
size=$(stat -c %s "$newest")
((size >= MIN_BYTES)) || die "Neueste Sicherung ist nur $size Bytes gross: $newest"
(cd "$(dirname "$newest")" && sha256sum --check --status -- "$(basename "$newest").sha256") || die "Prüfsumme stimmt nicht: $newest"

if ((${#files[@]} == 2)); then
  prev_size=$(stat -c %s "${files[1]}")
  ((size * 2 >= prev_size)) || die "Neueste Sicherung ist weniger als halb so gross wie die davor ($size gegen $prev_size Bytes)"
fi
log "Sicherungen in Ordnung: $newest ($size Bytes, $((age_s / 60)) Minuten alt)"
