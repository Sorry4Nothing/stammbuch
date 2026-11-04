#!/usr/bin/env bash
# Verschlüsselte logische Sicherung der Datenbank (pg_dump) mit Rotation.
#
# Ablauf: pg_dump (Custom-Format) -> age (Public-Key-Verschlüsselung) -> Datei + SHA-256.
# Der Server kennt nur den öffentlichen Schlüssel. Wer den Server übernimmt, kann damit keine
# Sicherung entschlüsseln (SR-42). Den privaten Schlüssel braucht nur die Wiederherstellung.
#
# Konfiguration: /etc/stammbuch/backup.env (Vorlage: backup.env.example). Verbindung zur Datenbank
# über die üblichen libpq-Variablen (PGHOST, PGUSER, PGDATABASE, PGSSLMODE) und PGPASSFILE, nie über
# ein Passwort auf der Kommandozeile.
set -Eeuo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$here/lib.sh"
load_env
: "${AGE_RECIPIENT:?AGE_RECIPIENT fehlt (öffentlicher age-Schlüssel, beginnt mit age1)}"
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}

require pg_dump age sha256sum
# BACKUP_NOW nur für Tests (Format 20261101T020000Z).
ts=${BACKUP_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ $ts =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Ungültiger Zeitstempel: $ts"
name="stammbuch-$ts.dump.age"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"
tmp=$(mktemp "$BACKUP_DIR/.tmp-XXXXXX")
trap 'rm -f -- "$tmp"' EXIT

log "Sicherung beginnt: $name"
# pipefail: schlägt pg_dump oder age fehl, bricht das Skript ab und es bleibt keine halbe Datei zurück.
pg_dump --format=custom --no-owner --no-privileges --compress=6 | age --recipient "$AGE_RECIPIENT" --output "$tmp"
[[ -s $tmp ]] || die "Sicherung ist leer"

out="$BACKUP_DIR/daily/$name"
mv -- "$tmp" "$out"
(cd "$BACKUP_DIR/daily" && sha256sum -- "$name" >"$name.sha256")

# Wochen- und Monatsstand: sonntags bzw. am Ersten (UTC) eine Kopie in eigener Aufbewahrung.
if [[ $(date -u -d "${ts:0:8}" +%u) == 7 ]]; then cp -- "$out" "$out.sha256" "$BACKUP_DIR/weekly/"; fi
if [[ ${ts:6:2} == 01 ]]; then cp -- "$out" "$out.sha256" "$BACKUP_DIR/monthly/"; fi
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"
prune "$BACKUP_DIR/monthly" "$KEEP_MONTHLY"

# Zweite Kopie ausserhalb des Servers (bei Serververlust sonst alles weg). Optional, empfohlen.
if [[ -n ${OFFSITE_REMOTE:-} ]]; then
  require rclone
  rclone copy -- "$out" "$OFFSITE_REMOTE/daily/"
  rclone copy -- "$out.sha256" "$OFFSITE_REMOTE/daily/"
  log "Offsite-Kopie nach $OFFSITE_REMOTE abgelegt"
fi

date +%s >"$BACKUP_DIR/last-success"
log "Sicherung fertig: $out ($(stat -c %s "$out") Bytes)"
# Optionaler Lebenszeichen-Ping an einen Überwachungsdienst: er schlägt Alarm, wenn er ausbleibt.
if [[ -n ${HEALTHCHECK_URL:-} ]]; then curl -fsS -m 10 --retry 3 -o /dev/null -- "$HEALTHCHECK_URL" || log "Ping fehlgeschlagen"; fi
