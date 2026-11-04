# @stammbuch/db

Platzhalter. Schema, Migrationen und Datenzugriff entstehen in Issue #3.

## Migrationen

Migrationen sind reines SQL und liegen in `migrations/`. Dateiname:

```
<YYYYMMDDHHmm>_<modul>_<name>.sql
```

- `YYYYMMDDHHmm`: Zeitstempel (UTC) der Erstellung. Er bestimmt die Reihenfolge.
- `<modul>`: Fachmodul, dem die Änderung gehört (z. B. `mitglieder`, `buchhaltung`).
- `<name>`: kurze Beschreibung in Kleinbuchstaben, Wörter mit `_` getrennt.

Beispiel: `202611041530_mitglieder_create_person.sql`

Regeln:

- Bereits gemergte Migrationen werden nie geändert. Korrekturen sind eine neue Migration.
- Der Zeitstempel verhindert Namenskollisionen, wenn mehrere Branches parallel Migrationen anlegen.
- Zerstörende Änderungen (DROP, Datenlöschung) brauchen einen ausdrücklichen Hinweis im PR und ein Backup.
- Der Test `test/migrations.test.ts` prüft die Namenskonvention.
