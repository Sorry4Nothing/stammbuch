# Design Stammbuch

Die klickbaren Entwürfe liegen im Claude-Artifact und nicht im Repo:
https://claude.ai/artifact/56VW654FMxXFqpoNbNzAFW

Alle Bildschirme gibt es je in Hell und Dunkel (113 Bildschirme, Dateien `project/gX-NN-hell|dunkel.dc.html`). Dieser Ordner enthält nur die Grundlagen für die Umsetzung.

## Inhalt

| Datei | Zweck |
|---|---|
| `tokens.css` | Alle Design-Tokens als CSS-Variablen (Farben hell/dunkel, Schrift, Abstände, Radien, Schatten, Fokus, Z-Index, Layoutmasse) |
| `fonts.css`, `fonts/` | Inter 400/500/600/700 (latin, latin-ext), selbst gehostet, Lizenz SIL OFL 1.1 in `fonts/LICENSE-OFL.txt` |
| `contrast.mjs` | WCAG-Kontrastprüfung der Tokens (`node designs/contrast.mjs`, Exit 1 bei Durchfall) |
| `KONTRAST.md` | Gemessene Werte und Auswertung |

## Bildschirm-Gruppen

| Gruppe | Titel | Bildschirme |
|---|---|---|
| g1 | Zugang | 1.1 bis 1.12 |
| g2 | Start und Systemzustände | 2.1 bis 2.8 |
| g3 | Personen | 3.1 bis 3.15 |
| g4 | Rechnungen | 4.1 bis 4.12 |
| g5 | Buchhaltung | 5.1 bis 5.10 |
| g6 | Auswertungen und Periodenabschluss | 6.1 bis 6.8 |
| g7 | Mail | 7.1 bis 7.12 |
| g8 | Kalender | 8.1 bis 8.7 |
| g9 | Einstellungen | 9.1 bis 9.15 |
| g10 | Chef-Admin | 10.1 bis 10.6 |
| g11 | Design-Guide | 11.1 Farben, 11.2 Typografie und Abstände, 11.3 Schaltflächen und Felder, 11.4 Tabellen und Meldungen, 11.5 Dialoge und Tabs, 11.6 Symbole, 11.7 Papier und Druck, 11.8 Tastatur, Fokus und Zugänglichkeit |

Der Bildschirm 1.1 (Login, hell) heisst im Artifact `project/Main.dc.html`. Die Titel der Bildschirme stehen in `project/canvas.json` (`boards.*.title`).

## Tokens verwenden

```html
<link rel="stylesheet" href="designs/fonts.css">
<link rel="stylesheet" href="designs/tokens.css">
```

```css
.card {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  font: var(--fw-regular) var(--fs-base)/var(--lh-base) var(--font-sans);
}
```

Regeln:
- Farben nur als `var(--...)`, nie als Hex im Code.
- Statusfarben (`--success`, `--warning`, `--error`) nur für Flächen, Linien und Symbole. Statustext immer `--*-text` auf `--*-bg`, dazu Symbol oder Wort.
- Mail- und Rechnungsvorschau mit `--paper`, `--paper-text`, `--paper-muted`, `--paper-line`. Diese bleiben in beiden Themes weiss/dunkel.
- Schrift nie kleiner als `--fs-hint` (12 px). Zahlen in Tabellen rechtsbündig mit `font-variant-numeric: tabular-nums`.
- Fokus: der Ring ist global über `:focus-visible` gesetzt (`--focus-ring`, `--focus-offset`). Nicht entfernen.
- Mindestbreite der Oberfläche `--layout-min-width` (1280 px), nur Desktop.

## Theme umschalten

Das Theme steht im Attribut `data-theme` am `<html>`-Element. Ohne Attribut gilt Hell.

```js
document.documentElement.dataset.theme = 'dark'; // oder 'light'
```

Die Wahl sollte pro Benutzer gespeichert und beim Laden vor dem ersten Rendern gesetzt werden, damit es nicht aufblitzt.

## Abweichungen Artifact und Projektplan

Das Artifact enthält bei mehreren Farben leicht andere Hex-Werte als die verbindliche Palette in `projektplan.md` (Abschnitt «Farben»). In `tokens.css` gelten die Werte aus `projektplan.md`. Werte, die der Projektplan nicht nennt (`--surface-2`, `--text-muted`, `--on-primary`, `--on-accent`, `--border-strong`, `--focus`, `--*-text`, `--*-bg`, `--paper-muted`, `--paper-line`, `--desk`, `--scrim`), stammen aus dem Artifact. Z-Index-Skala und `--font-mono` sind im Artifact nicht festgelegt und hier ergänzt (JetBrains Mono aus dem Artifact wird nicht gehostet).

| Token | Hell Artifact | Hell Projektplan | Dunkel Artifact | Dunkel Projektplan |
|---|---|---|---|---|
| `--bg` | `#F3EEE2` | `#F7F5F0` | `#111A15` | `#101713` |
| `--surface` | `#FBF8F1` | `#FFFFFF` | `#1A241F` | `#19231D` |
| `--text` | `#1F2A24` (gleich) | `#1F2A24` | `#E9E6DB` | `#E8EDE9` |
| `--primary` | `#1F5A3E` | `#2F6B4F` | `#6FBF92` | `#6FBF98` |
| `--accent` | `#C98A2B` | `#C8873A` | `#E0A94A` | `#E0A662` |
| `--border` | `#D3CCB8` | `#E1DDD2` | `#33423A` | `#2B3A31` |
| `--success` | `#2E7D4F` | `#1E8E5A` | `#5FBF84` | `#4CC38A` |
| `--warning` | `#B7791F` (gleich) | `#B7791F` | `#E0A94A` | `#E3B341` |
| `--error` | `#B3261E` | `#C0392B` | `#F07A70` | `#F26D5F` |
| `--paper-text` | `#1A1A1A` | `#111111` | `#1A1A1A` | `#111111` |

Folge: Die Kontrastzahlen im Artifact (11.1) stimmen für die Projektplan-Palette nicht exakt. Massgeblich ist `KONTRAST.md`.
