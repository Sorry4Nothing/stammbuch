# Design: Abweichungen von den Design-Boards

Die Boards des Design-Guides (Version 1.0) bleiben die Vorlage für Masse, Farben und Komponenten. Auf Wunsch des Nutzers (UX-/UI-Durchlauf 2026-11-09) gelten folgende Abweichungen. Farben, Abstände und Radien kommen weiter nur aus `apps/web/src/styles/tokens.css`.

## Karten (`Panel`, `.panel`)

- Der Kartentitel hat kein dunkles Band mehr: Text 16/600 auf der Kartenfläche (`--surface`), darunter eine Linie von 1 px in `--border`. Die Karte hat einen Rand von 1 px in `--border`.
- Karten nur dort, wo gruppiert wird: Diagrammkarten, Formularabschnitte, Tabellen mit Titel. Reine Aktions- und Navigationsblöcke («Aktionen», «Bereiche») bleiben ohne Karte: `<Panel plain>`.
- Keine Karte in der Karte. Die Vorschau des Briefkopfs (Einstellungen, Logo) liegt als Papier mit feinem Rand direkt in der Karte, ohne eigenen Tisch.

## Zahlen und Formate (`ui/format.ts`)

- Beträge sind ganze Rappen. Eine Funktion für alle Module: `formatChf` («CHF 1'250.00»), `formatAmount` («1'250.00»), `formatInt` («1'426»). Tausendertrenner ist das gerade Hochkomma, wie in allen bisherigen Modulen und Tests; Minus ist überall das echte Minuszeichen U+2212 («CHF −1'150.00»).
- `formatIban` gruppiert in Vierergruppen, `formatPhone` setzt Schweizer Nummern als «079 123 45 67» bzw. «+41 79 123 45 67» und lässt andere Formen unverändert. Beide sind reine Anzeigehilfen; gespeichert wird, was die API liefert. Das Rechnungs-PDF (API) bleibt unverändert.
- Zähler hinter Titeln und Tabs: «Titel (n)». Ein Badge zeigt einen Zähler nur in der Seitennavigation. Tabellenfuss: «n von m». Die Seitenzahl («Seite 1 von 8») erscheint nur bei mehr als einer Seite.

## Navigation

- Nur die globale Ebene (Seitenleiste der App) ist in der Primärfarbe gefüllt. Das aktive Element eines Untermenüs (Mail, Einstellungen) trägt `--surface-2` und eine Kante links von 3 px in `--primary`.
- Umschalter aus Schaltflächen (`aria-pressed="true"`, z. B. Kalender Monat/Woche) sind aktiv neutral (`--surface-2`, Rand `--text`), nicht in der Primärfarbe.

## Dunkles Theme und Platzhalter

- Karten sind rund 1.2:1 heller als der Grund und tragen einen sichtbaren Rand; das Vollflächen-Mint ist gedämpft (`--primary` #6bb386). Messung: `docs/KONTRAST.md`, `node docs/contrast.mjs` (alle Paare bestehen).
- Platzhalter sind gedämpft (`--text-muted`) und kursiv, damit sie nicht wie eingetragene Werte wirken.

## Steuerelemente

- Höhe von Schaltflächen und Feldern bleibt 32 px (`--layout-control-height`), die App ist nur für Desktop. Eingaben in Tabellenzellen sind mindestens 28 px hoch. Der Fokusring bleibt.
- Export nach Excel: Symbol `table`, Text «Als Excel-Datei exportieren» (nicht «.xlsx»).
