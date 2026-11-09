# Bewegung der Oberfläche

Dezent, schnell, durchgängig. Reines CSS, kein Animations-Framework. Alle Werte stehen als Tokens in `apps/web/src/styles/tokens.css`, alle Regeln in `apps/web/src/styles/motion.css` (wird in `main.tsx` nach `shell.css` geladen).

## Tokens

| Token            | Wert                           | Verwendung                                          |
| ---------------- | ------------------------------ | --------------------------------------------------- |
| `--dur-fast`     | 120 ms                         | Hover, Haken, Schalter, Tab-Wechsel, Menü           |
| `--dur-base`     | 200 ms                         | Dialog, Scrim, Toast, Meldung, Zeilen, Seitenaufbau |
| `--dur-slow`     | 320 ms                         | Anmeldekarte, Theme-Wechsel                         |
| `--ease-out`     | `cubic-bezier(0.2, 0, 0, 1)`   | Einblenden, Hover                                   |
| `--ease-in-out`  | `cubic-bezier(0.4, 0, 0.2, 1)` | Theme-Wechsel, Lade-Puls                            |
| `--motion-shift` | 6 px                           | Weg beim Einblenden (Rise, Menü, Toast ×4)          |
| `--motion-scale` | 0.98                           | Startgrösse Dialog und Menü, gedrückte Schaltfläche |
| `--motion-pop`   | 0.7                            | Startgrösse kleiner Elemente (Zähler, Haken, Punkt) |
| `--stagger`      | 40 ms                          | Versatz je Stufe beim Seitenaufbau                  |

## Was sich bewegt

- **Tab-Wechsel**: Ein ausgeblendeter Tab (`hidden`) blendet beim Einblenden kurz ein (120 ms, 6 px). Der Inhalt bleibt gemountet.
- **Seitenaufbau**: Beim ersten Öffnen eines Tabs trägt das Panel die Klasse `tabpanel--fresh` (450 ms, dann entfernt `TabPanels.tsx` sie). Kinder von `.page__body` staffeln sich ein: höchstens 6 Stufen, 5 × 40 ms + 200 ms = 400 ms.
- **Dialog**: Scrim blendet ein, Dialog blendet ein und skaliert von 0.98. Es gibt keine Ausblend-Animation, damit Fokusfalle und Unmount unberührt bleiben.
- **Toast** fährt von rechts ein; **Meldungen** (`.msg`) blenden mit 6 px ein.
- **Menüs und Auswahllisten** (`[role="menu"]`, `[role="listbox"]`, `.menu`) blenden ein; die Trefferliste der Suche nicht, weil sie bei jedem Zeichen wechselt.
- **Tabellenzeilen** (`tr[data-row-key]` der `DataTable`) blenden ein, Auswahl und Hover wechseln weich.
- **Schaltflächen, Felder, Verweise, Seitenleiste, Seitentabs, Tabs**: Hintergrund, Rand und Farbe wechseln in `--dur-fast`. Gedrückte Schaltfläche skaliert auf `--motion-scale`.
- **Kontrollkästchen, Optionsfeld, Schalter**: Haken und Punkt poppen ein, der Schalterknopf gleitet per `transform`.
- **Zähler** in der Seitenleiste: `key` auf dem Wert, damit der neue Wert einpoppt.
- **Ladezustand**: Klasse `is-loading` auf dem `role="status"`-Element. Der Text bleibt, nur die Deckkraft pulsiert (einzige Endlosanimation).
- **Zugangsseiten**: Marke blendet ein, Karte blendet ein und steigt 6 px.
- **Theme-Wechsel**: `ThemeProvider` setzt `theme-anim` auf `<html>` für 360 ms, nur beim Umschalten, nie beim Seitenaufbau.
- **Akkordeon** (`<details>`): Inhalt blendet beim Öffnen ein.
- **Tab öffnen**: Der neue Tab blendet nur per Deckkraft ein. Ein Ein-/Ausfahren der Breite gibt es nicht (Layout-Eigenschaft, Tab-Umsortierung).

## Regeln

1. Nur `transform` und `opacity` animieren, dazu Farbwechsel bei Hover. Keine Layout-Eigenschaften (`width`, `height`, `left`, `margin`).
2. Dauern und Kurven nur über Tokens. Keine festen Werte, ausser dem Lade-Puls (1.4 s).
3. Wege und Skalierungen nur über `--motion-shift`, `--motion-scale`, `--motion-pop` (der Test `motion.test.tsx` prüft das für alle `@keyframes`).
4. Animationen mit `backwards` als Füllmodus, nie `forwards`: nach dem Ende bleibt kein `transform` stehen (keine neuen Stapel- oder Positionskontexte).
5. Elemente bleiben während der Animation klickbar und fokussierbar. Der Fokus-Ring wird nicht animiert und erscheint sofort (kein `outline` in `motion.css`).
6. Keine Information nur über Bewegung. Texte und `role`-Attribute bleiben unverändert.
7. Keine Endlosanimation ausser dem Lade-Puls. `will-change` nur, wenn eine Messung es belegt (bisher nirgends nötig).

## Reduzierte Bewegung

`@media (prefers-reduced-motion: reduce)` in `motion.css` setzt die Tokens um:

- `--motion-shift: 0px`, `--motion-scale: 1`, `--motion-pop: 1`, `--stagger: 0ms`: nichts verschiebt oder skaliert sich mehr.
- `--dur-fast: 0ms`: Hover-Wechsel sind sofort.
- `--dur-base` und `--dur-slow`: 120 ms. Es bleibt ein reines Einblenden.
- `.is-loading` pulsiert nicht.
- Der Theme-Wechsel setzt keine Klasse (`ThemeProvider` prüft `matchMedia`), das CSS schaltet zusätzlich die Übergänge ab.

Eine neue Animation, die nur diese Tokens nutzt, folgt dieser Regel automatisch.

## Neue Animation bauen

1. Keyframes in `motion.css` mit Wegen aus den Tokens: `@keyframes m-neu { from { opacity: 0; transform: translateY(var(--motion-shift)); } }`. Nur der Startzustand nötig, das Ziel ist der normale Stil.
2. Am Element: `animation: m-neu var(--dur-base) var(--ease-out) backwards;`.
3. Soll sie nur beim Seitenaufbau laufen, an `.tabpanel--fresh` koppeln; Staffelung über `animation-delay: calc(var(--stagger) * n)` mit n höchstens 5.
4. Zustandswechsel (Hover, Auswahl): `transition` auf `background-color`, `border-color`, `color` oder `transform` mit `--dur-fast`.
5. Wiederholt sich die Animation bei neuem Inhalt (Zähler), setzt React einen `key` auf das Element.
6. Prüfen: Hell und Dunkel, mit `prefers-reduced-motion: reduce` (Browser-Entwicklerwerkzeuge), Tastaturbedienung, `pnpm --filter @stammbuch/web exec vitest run src/motion.test.tsx`.
