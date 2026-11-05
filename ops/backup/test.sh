#!/usr/bin/env bash
# Selbsttest der Backup-Skripte mit Attrappen für pg_dump und age (keine Datenbank nötig).
# Aufruf: bash ops/backup/test.sh   (oder: pnpm test:ops). Prüft Ablauf, Rotation und Fehlerfälle.
set -Eeuo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin"
failures=0

ok() { printf 'ok     %s\n' "$1"; }
fail() { printf 'FEHLER %s\n' "$1"; failures=$((failures + 1)); }
check() { # check "Beschreibung" Befehl...
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}
check_not() {
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$desc"; else ok "$desc"; fi
}

# Attrappen: pg_dump liefert Bytes, age schreibt stdin in die --output-Datei (oder scheitert auf Wunsch).
cat >"$work/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
head -c 4096 /dev/zero | tr '\0' 'x'
EOF
cat >"$work/bin/age" <<'EOF'
#!/usr/bin/env bash
[[ -z ${STUB_AGE_FAIL:-} ]] || exit 1
while (($#)); do case $1 in --output) out=$2; shift 2 ;; *) shift ;; esac; done
cat >"$out"
EOF
chmod +x "$work/bin/pg_dump" "$work/bin/age"
export PATH="$work/bin:$PATH"

export BACKUP_ENV_FILE="$work/backup.env"
cat >"$BACKUP_ENV_FILE" <<EOF
BACKUP_DIR=$work/backups
AGE_RECIPIENT=age1testtesttesttest
KEEP_DAILY=3
KEEP_WEEKLY=2
KEEP_MONTHLY=1
EOF
dir="$work/backups"

# --- Rotation ---
(
  # shellcheck source=lib.sh
  source "$here/lib.sh"
  mkdir -p "$work/p"
  for i in 1 2 3 4 5; do : >"$work/p/stammbuch-2026110${i}T020000Z.dump.age"; : >"$work/p/stammbuch-2026110${i}T020000Z.dump.age.sha256"; done
  prune "$work/p" 2 2>/dev/null
  [[ $(ls "$work/p" | wc -l) == 4 ]] && [[ -e $work/p/stammbuch-20261105T020000Z.dump.age && -e $work/p/stammbuch-20261104T020000Z.dump.age.sha256 && ! -e $work/p/stammbuch-20261103T020000Z.dump.age ]]
) && ok "prune behält die neuesten und löscht die Prüfsummen mit" || fail "prune"

# --- Backup-Lauf: 2026-11-01 ist ein Sonntag und der Erste ---
BACKUP_NOW=20261101T020000Z bash "$here/backup.sh" 2>/dev/null && ok "backup.sh läuft durch" || fail "backup.sh läuft durch"
check "Sicherung und Prüfsumme in daily" test -s "$dir/daily/stammbuch-20261101T020000Z.dump.age" -a -s "$dir/daily/stammbuch-20261101T020000Z.dump.age.sha256"
check "Sonntag: Kopie in weekly" test -s "$dir/weekly/stammbuch-20261101T020000Z.dump.age"
check "Erster: Kopie in monthly" test -s "$dir/monthly/stammbuch-20261101T020000Z.dump.age"
check "last-success wurde geschrieben" test -s "$dir/last-success"

for d in 02 03 04 05; do BACKUP_NOW=202611${d}T020000Z bash "$here/backup.sh" 2>/dev/null; done
[[ $(ls "$dir"/daily/*.dump.age | wc -l) == 3 ]] && ok "daily behält nur KEEP_DAILY" || fail "daily behält nur KEEP_DAILY"
check "Älteste daily-Datei ist weg" test ! -e "$dir/daily/stammbuch-20261101T020000Z.dump.age"
check "weekly/monthly bleiben erhalten" test -e "$dir/weekly/stammbuch-20261101T020000Z.dump.age" -a -e "$dir/monthly/stammbuch-20261101T020000Z.dump.age"

# --- Fehlerfälle ---
before=$(ls -A "$dir/daily" | wc -l)
check_not "Fehler in age bricht ab" env STUB_AGE_FAIL=1 BACKUP_NOW=20261106T020000Z bash "$here/backup.sh"
[[ $(ls -A "$dir/daily" | wc -l) == "$before" ]] && ok "bei Fehler bleibt keine halbe Datei" || fail "bei Fehler bleibt keine halbe Datei"
check_not "ungültiger Zeitstempel wird abgelehnt" env BACKUP_NOW='x;rm -rf /' bash "$here/backup.sh"
check_not "fehlende Konfiguration bricht ab" env BACKUP_ENV_FILE="$work/gibtsnicht" bash "$here/backup.sh"

# --- verify.sh ---
check "verify.sh akzeptiert frische Sicherung" bash "$here/verify.sh"
echo $(($(date +%s) - 30 * 3600)) >"$dir/last-success"
check_not "verify.sh meldet zu alte Sicherung" bash "$here/verify.sh"
date +%s >"$dir/last-success"
newest=$(ls "$dir"/daily/*.dump.age | sort | tail -1)
cp "$newest" "$work/saved"
printf 'manipuliert' >>"$newest"
check_not "verify.sh meldet falsche Prüfsumme" bash "$here/verify.sh"
cp "$work/saved" "$newest"
check "verify.sh ok nach Wiederherstellung der Datei" bash "$here/verify.sh"
: >"$newest"
(cd "$(dirname "$newest")" && sha256sum -- "$(basename "$newest")" >"$(basename "$newest").sha256")
check_not "verify.sh meldet leere Sicherung" bash "$here/verify.sh"

# --- restore.sh: Eingaben werden geprüft, bevor etwas passiert ---
export AGE_IDENTITY="$work/key.txt"
: >"$AGE_IDENTITY"
check_not "restore.sh lehnt gefährlichen Datenbanknamen ab" bash "$here/restore.sh" "$newest" 'x; drop database stammbuch'
check_not "restore.sh lehnt fehlende Datei ab" bash "$here/restore.sh" "$work/gibtsnicht" zieldb

if ((failures > 0)); then
  printf '\n%d Prüfung(en) fehlgeschlagen\n' "$failures"
  exit 1
fi
printf '\nAlle Prüfungen bestanden\n'
