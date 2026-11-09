# Kontrastmessung

Gemessen mit `node docs/contrast.mjs` (liest `apps/web/src/styles/tokens.css`, WCAG 2.x, relative Luminanz). Schwellen: Normaltext 4.5, grosser Text und UI-Komponenten 3.0. Art `info` wird nur ausgegeben und nicht bewertet. Das Skript endet mit Exit-Code 1, solange eine Prüfung durchfällt.

## Farbquelle

Verbindlich sind die Hexwerte aus dem Design-Artifact (Gruppe 11). Sie weichen von der Palette in `projektplan.md` ab; `tokens.css` enthält die Artifact-Werte.

Die Hexwerte entsprechen dem Design-Artifact (Stand November 2026) vollständig. Drei Nicht-Text-Paare liegen im hellen Theme unter 3:1 und stehen deshalb als `info` im Skript: `accent` auf `surface` (1.78:1), `warning` auf `surface` (2.78:1) und `warning` auf `warning-bg` (2.49:1). Ausgleich im Code: Der Akzentpunkt (ungespeicherte Eingaben) hat einen Rand in `border-strong`, und Warnungen tragen immer Text in `warning-text` auf `warning-bg` (6+:1) neben dem Symbol, sodass die Information nicht allein an der Farbe hängt (WCAG 1.4.1, 1.4.11).

## Ergebnis (Artifact-Palette)

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
dark   text  text auf surface                       #e9ede4/#17201a   14.07:1   4.5  OK
dark   text  text auf surface-2                     #e9ede4/#1f2a23   12.52:1   4.5  OK
dark   text  text-muted auf bg                      #a3ae9f/#101712   7.90:1    4.5  OK
dark   text  text-muted auf surface                 #a3ae9f/#17201a   7.24:1    4.5  OK
dark   text  text-muted auf surface-2               #a3ae9f/#1f2a23   6.45:1    4.5  OK
dark   text  on-primary auf primary                 #0b1a10/#7fc59a   8.85:1    4.5  OK
dark   text  on-accent auf accent                   #1d2a22/#d9b96a   7.89:1    4.5  OK
dark   text  primary auf surface                    #7fc59a/#17201a   8.23:1    4.5  OK
dark   text  primary auf bg                         #7fc59a/#101712   8.98:1    4.5  OK
dark   text  success-text auf success-bg            #7bd79f/#12301e   8.22:1    4.5  OK
dark   text  warning-text auf warning-bg            #f2c75c/#33270a   9.13:1    4.5  OK
dark   text  error-text auf error-bg                #ffa8a0/#3c1613   8.63:1    4.5  OK
dark   text  error-text auf surface                 #ffa8a0/#17201a   9.03:1    4.5  OK
dark   text  paper-text auf paper                   #1b1b1b/#ffffff   17.22:1   4.5  OK
dark   text  paper-muted auf paper                  #5a5a5a/#ffffff   6.90:1    4.5  OK
dark   ui    focus auf surface                      #8fc8ff/#17201a   9.44:1    3    OK
dark   ui    focus auf bg                           #8fc8ff/#101712   10.30:1   3    OK
dark   ui    border-strong auf surface              #6f7c70/#17201a   3.81:1    3    OK
dark   ui    border-strong auf bg                   #6f7c70/#101712   4.16:1    3    OK
dark   ui    success auf surface                    #4fb57a/#17201a   6.54:1    3    OK
dark   info  warning auf surface                    #e0a526/#17201a   7.62:1    -    info
dark   ui    error auf surface                      #f0786e/#17201a   6.05:1    3    OK
dark   info  accent auf surface                     #d9b96a/#17201a   8.82:1    -    info
dark   ui    success auf success-bg                 #4fb57a/#12301e   5.60:1    3    OK
dark   info  warning auf warning-bg                 #e0a526/#33270a   6.67:1    -    info
dark   ui    error auf error-bg                     #f0786e/#3c1613   5.79:1    3    OK
dark   info  success auf surface                    #4fb57a/#17201a   6.54:1    -    info
dark   info  warning auf surface                    #e0a526/#17201a   7.62:1    -    info
dark   info  error auf surface                      #f0786e/#17201a   6.05:1    -    info
dark   info  accent auf surface                     #d9b96a/#17201a   8.82:1    -    info
```
