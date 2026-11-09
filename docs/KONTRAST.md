# Kontrastmessung

Gemessen mit `node docs/contrast.mjs` (liest `apps/web/src/styles/tokens.css`, WCAG 2.x, relative Luminanz). Schwellen: Normaltext 4.5, grosser Text und UI-Komponenten 3.0. Art `info` wird nur ausgegeben und nicht bewertet. Das Skript endet mit Exit-Code 1, solange eine Prüfung durchfällt.

## Farbquelle

Verbindlich sind die Hexwerte aus dem Design-Artifact (Gruppe 11). Sie weichen von der Palette in `projektplan.md` ab; `tokens.css` enthält die Artifact-Werte.

Die Hexwerte entsprechen dem Design-Artifact (Stand November 2026) vollständig. Drei Nicht-Text-Paare liegen im hellen Theme unter 3:1 und stehen deshalb als `info` im Skript: `accent` auf `surface` (1.78:1), `warning` auf `surface` (2.78:1) und `warning` auf `warning-bg` (2.49:1). Ausgleich im Code: Der Akzentpunkt (ungespeicherte Eingaben) hat einen Rand in `border-strong`, und Warnungen tragen immer Text in `warning-text` auf `warning-bg` (6+:1) neben dem Symbol, sodass die Information nicht allein an der Farbe hängt (WCAG 1.4.1, 1.4.11).

## Ergebnis (Artifact-Palette)

Dunkles Theme (Stand Gruppe F, UX-Durchlauf 2026-11-09): Karten (`surface` #1d2922) liegen rund 1.2:1 heller auf dem Grund (`bg` #101712) und tragen zusätzlich einen 1-px-Rand in `border` (#3d4d42, 2.0:1 auf dem Grund, 1.7:1 auf der Karte; Trennlinie ohne eigene Information, deshalb `info`). Das Vollflächen-Mint `primary` ist von #7fc59a auf #6bb386 gedämpft; `on-primary` darauf 7.2:1, `primary` als Text auf `surface` 6.0:1.

48 von 48 Prüfungen bestanden, 0 durchgefallen.

```text
Theme  Art   Paar                                   Farben            Kontrast  Min  Ergebnis
light  text  text auf bg                            #1d2a22/#f4efe4   13.02:1   4.5  OK
light  text  text auf surface                       #1d2a22/#fbf8f1   14.08:1   4.5  OK
light  text  text auf surface-2                     #1d2a22/#ede6d6   12.01:1   4.5  OK
light  text  text-muted auf bg                      #536057/#f4efe4   5.76:1    4.5  OK
light  text  text-muted auf surface                 #536057/#fbf8f1   6.23:1    4.5  OK
light  text  text-muted auf surface-2               #536057/#ede6d6   5.31:1    4.5  OK
light  text  on-primary auf primary                 #ffffff/#1f5a3d   8.11:1    4.5  OK
light  text  on-accent auf accent                   #1d2a22/#d9b96a   7.89:1    4.5  OK
light  text  primary auf surface                    #1f5a3d/#fbf8f1   7.65:1    4.5  OK
light  text  primary auf bg                         #1f5a3d/#f4efe4   7.08:1    4.5  OK
light  text  success-text auf success-bg            #1b5e36/#ddeee2   6.44:1    4.5  OK
light  text  warning-text auf warning-bg            #6b4a00/#fbebc2   6.82:1    4.5  OK
light  text  error-text auf error-bg                #9c1c14/#fadad6   6.20:1    4.5  OK
light  text  error-text auf surface                 #9c1c14/#fbf8f1   7.65:1    4.5  OK
light  text  paper-text auf paper                   #1b1b1b/#ffffff   17.22:1   4.5  OK
light  text  paper-muted auf paper                  #5a5a5a/#ffffff   6.90:1    4.5  OK
light  ui    focus auf surface                      #0b5fa5/#fbf8f1   6.20:1    3    OK
light  ui    focus auf bg                           #0b5fa5/#f4efe4   5.73:1    3    OK
light  ui    border-strong auf surface              #7f7a66/#fbf8f1   4.06:1    3    OK
light  ui    border-strong auf bg                   #7f7a66/#f4efe4   3.75:1    3    OK
light  info  border auf bg                          #d6cdb8/#f4efe4   1.38:1    -    info
light  info  border auf surface                     #d6cdb8/#fbf8f1   1.49:1    -    info
light  info  surface auf bg                         #fbf8f1/#f4efe4   1.08:1    -    info
light  ui    success auf surface                    #2e7d4f/#fbf8f1   4.76:1    3    OK
light  info  warning auf surface                    #c98a0b/#fbf8f1   2.78:1    -    info
light  ui    error auf surface                      #b3261e/#fbf8f1   6.16:1    3    OK
light  info  accent auf surface                     #d9b96a/#fbf8f1   1.78:1    -    info
light  ui    success auf success-bg                 #2e7d4f/#ddeee2   4.18:1    3    OK
light  info  warning auf warning-bg                 #c98a0b/#fbebc2   2.49:1    -    info
light  ui    error auf error-bg                     #b3261e/#fadad6   5.00:1    3    OK
light  info  success auf surface                    #2e7d4f/#fbf8f1   4.76:1    -    info
light  info  warning auf surface                    #c98a0b/#fbf8f1   2.78:1    -    info
light  info  error auf surface                      #b3261e/#fbf8f1   6.16:1    -    info
light  info  accent auf surface                     #d9b96a/#fbf8f1   1.78:1    -    info
dark   text  text auf bg                            #e9ede4/#101712   15.35:1   4.5  OK
dark   text  text auf surface                       #e9ede4/#1d2922   12.71:1   4.5  OK
dark   text  text auf surface-2                     #e9ede4/#27342b   10.98:1   4.5  OK
dark   text  text-muted auf bg                      #a3ae9f/#101712   7.90:1    4.5  OK
dark   text  text-muted auf surface                 #a3ae9f/#1d2922   6.54:1    4.5  OK
dark   text  text-muted auf surface-2               #a3ae9f/#27342b   5.65:1    4.5  OK
dark   text  on-primary auf primary                 #0b1a10/#6bb386   7.20:1    4.5  OK
dark   text  on-accent auf accent                   #1d2a22/#d9b96a   7.89:1    4.5  OK
dark   text  primary auf surface                    #6bb386/#1d2922   6.04:1    4.5  OK
dark   text  primary auf bg                         #6bb386/#101712   7.30:1    4.5  OK
dark   text  success-text auf success-bg            #7bd79f/#15351f   7.73:1    4.5  OK
dark   text  warning-text auf warning-bg            #f2c75c/#33270a   9.13:1    4.5  OK
dark   text  error-text auf error-bg                #ffa8a0/#3c1613   8.63:1    4.5  OK
dark   text  error-text auf surface                 #ffa8a0/#1d2922   8.16:1    4.5  OK
dark   text  paper-text auf paper                   #1b1b1b/#ffffff   17.22:1   4.5  OK
dark   text  paper-muted auf paper                  #5a5a5a/#ffffff   6.90:1    4.5  OK
dark   ui    focus auf surface                      #8fc8ff/#1d2922   8.53:1    3    OK
dark   ui    focus auf bg                           #8fc8ff/#101712   10.30:1   3    OK
dark   ui    border-strong auf surface              #75837a/#1d2922   3.79:1    3    OK
dark   ui    border-strong auf bg                   #75837a/#101712   4.58:1    3    OK
dark   info  border auf bg                          #3d4d42/#101712   2.03:1    -    info
dark   info  border auf surface                     #3d4d42/#1d2922   1.68:1    -    info
dark   info  surface auf bg                         #1d2922/#101712   1.21:1    -    info
dark   ui    success auf surface                    #4fb57a/#1d2922   5.91:1    3    OK
dark   info  warning auf surface                    #e0a526/#1d2922   6.88:1    -    info
dark   ui    error auf surface                      #f0786e/#1d2922   5.47:1    3    OK
dark   info  accent auf surface                     #d9b96a/#1d2922   7.97:1    -    info
dark   ui    success auf success-bg                 #4fb57a/#15351f   5.27:1    3    OK
dark   info  warning auf warning-bg                 #e0a526/#33270a   6.67:1    -    info
dark   ui    error auf error-bg                     #f0786e/#3c1613   5.79:1    3    OK
dark   info  success auf surface                    #4fb57a/#1d2922   5.91:1    -    info
dark   info  warning auf surface                    #e0a526/#1d2922   6.88:1    -    info
dark   info  error auf surface                      #f0786e/#1d2922   5.47:1    -    info
dark   info  accent auf surface                     #d9b96a/#1d2922   7.97:1    -    info
```
