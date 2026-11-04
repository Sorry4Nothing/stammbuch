#!/usr/bin/env bash
# Gemeinsame Funktionen der Backup-Skripte. Wird mit `source` geladen, nicht direkt ausgeführt.

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FEHLER: $*"; exit 1; }

require() {
  local cmd
  for cmd in "$@"; do command -v "$cmd" >/dev/null 2>&1 || die "Programm fehlt: $cmd"; done
}

# Lädt die Konfiguration (root-eigene Datei, Rechte 600, nie im Repository: SR-30).
load_env() {
  local file=${BACKUP_ENV_FILE:-/etc/stammbuch/backup.env}
  [[ -r $file ]] || die "Konfiguration nicht lesbar: $file (Vorlage: ops/backup/backup.env.example)"
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
  : "${BACKUP_DIR:?BACKUP_DIR fehlt in $file}"
}

# prune VERZEICHNIS ANZAHL: behält die ANZAHL neuesten Sicherungen, löscht ältere samt Prüfsumme.
# Der Dateiname enthält den UTC-Zeitstempel, die Sortierung nach Name ist also die nach Alter.
prune() {
  local dir=$1 keep=$2 file
  [[ $keep =~ ^[0-9]+$ ]] || die "Ungültige Aufbewahrungszahl: $keep"
  find "$dir" -maxdepth 1 -type f -name 'stammbuch-*.dump.age' -print | sort -r | tail -n +"$((keep + 1))" |
    while IFS= read -r file; do
      log "Lösche alte Sicherung: $file"
      rm -f -- "$file" "$file.sha256"
    done
}
