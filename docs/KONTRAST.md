# Kontrastmessung

Gemessen mit `node docs/contrast.mjs` (liest `apps/web/src/styles/tokens.css`, WCAG 2.x, relative Luminanz). Schwellen: Normaltext 4.5, grosser Text und UI-Komponenten 3.0. Art `info` wird nur ausgegeben und nicht bewertet. Das Skript endet mit Exit-Code 1, solange eine Prüfung durchfällt.

## Farbquelle

Verbindlich sind die Hexwerte aus dem Design-Artifact (Gruppe 11). Sie weichen bei `--bg`, `--surface`, `--text` (dunkel), `--primary`, `--accent`, `--border`, `--success`, `--warning` (dunkel), `--error` und `--paper-text` von der Palette in `projektplan.md` ab. `tokens.css` enthält die Artifact-Werte.

## Ergebnis (Artifact-Palette)

52 von 54 Prüfungen bestanden, 2 durchgefallen. Beide Fälle sind reine Zierfarben, die Information steht zusätzlich als Text oder Symbol (WCAG 1.4.11 verlangt dann keinen Mindestkontrast):

| Paar                             | Kontrast | Umgang                                                                                                                                              |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| hell: `accent` auf `surface`     | 2.77:1   | Punkt am Tab «Ungespeicherte Eingaben». Bedeutung steht im `aria-label`; der Punkt erhält zusätzlich einen 1-px-Rand in `--border-strong` (4.56:1). |
| hell: `warning` auf `warning-bg` | 2.97:1   | Rand der Warnmeldung. Die Meldung trägt Symbol und Text in `--warning-text` (6.98:1).                                                               |

```text
Theme  Art   Paar                                   Farben            Kontrast  Min  Ergebnis
light  text  text auf bg                            #1F2A24/#F3EEE2   12.82:1   4.5  OK
light  text  text auf surface                       #1F2A24/#FBF8F1   13.99:1   4.5  OK
light  text  text auf surface-2                     #1F2A24/#E9E3D3   11.59:1   4.5  OK
light  text  text-muted auf bg                      #4A554D/#F3EEE2   6.72:1    4.5  OK
light  text  text-muted auf surface                 #4A554D/#FBF8F1   7.34:1    4.5  OK
light  text  text-muted auf surface-2               #4A554D/#E9E3D3   6.08:1    4.5  OK
light  text  on-primary auf primary                 #FFFFFF/#1F5A3E   8.11:1    4.5  OK
light  text  on-accent auf accent                   #1F2A24/#C98A2B   5.06:1    4.5  OK
light  text  primary auf surface                    #1F5A3E/#FBF8F1   7.64:1    4.5  OK
light  text  primary auf bg                         #1F5A3E/#F3EEE2   7.00:1    4.5  OK
light  text  success-text auf success-bg            #1B5E38/#DCEBDD   6.27:1    4.5  OK
light  text  warning-text auf warning-bg            #6B4400/#F6E7C1   6.98:1    4.5  OK
light  text  error-text auf error-bg                #8C1D18/#F6DAD6   6.91:1    4.5  OK
light  text  error-text auf surface                 #8C1D18/#FBF8F1   8.59:1    4.5  OK
light  text  paper-text auf paper                   #1A1A1A/#FFFFFF   17.40:1   4.5  OK
light  text  paper-muted auf paper                  #555555/#FFFFFF   7.46:1    4.5  OK
light  ui    focus auf surface                      #1B5FB5/#FBF8F1   5.91:1    3    OK
light  ui    focus auf bg                           #1B5FB5/#F3EEE2   5.41:1    3    OK
light  ui    border-strong auf surface              #76725F/#FBF8F1   4.56:1    3    OK
light  ui    border-strong auf bg                   #76725F/#F3EEE2   4.18:1    3    OK
light  ui    success auf surface                    #2E7D4F/#FBF8F1   4.76:1    3    OK
light  ui    warning auf surface                    #B7791F/#FBF8F1   3.43:1    3    OK
light  ui    error auf surface                      #B3261E/#FBF8F1   6.16:1    3    OK
light  ui    accent auf surface                     #C98A2B/#FBF8F1   2.77:1    3    DURCHGEFALLEN
light  ui    success auf success-bg                 #2E7D4F/#DCEBDD   4.08:1    3    OK
light  ui    warning auf warning-bg                 #B7791F/#F6E7C1   2.97:1    3    DURCHGEFALLEN
light  ui    error auf error-bg                     #B3261E/#F6DAD6   4.95:1    3    OK
light  info  success auf surface                    #2E7D4F/#FBF8F1   4.76:1    -    info
light  info  warning auf surface                    #B7791F/#FBF8F1   3.43:1    -    info
light  info  error auf surface                      #B3261E/#FBF8F1   6.16:1    -    info
light  info  accent auf surface                     #C98A2B/#FBF8F1   2.77:1    -    info
dark   text  text auf bg                            #E9E6DB/#111A15   14.21:1   4.5  OK
dark   text  text auf surface                       #E9E6DB/#1A241F   12.77:1   4.5  OK
dark   text  text auf surface-2                     #E9E6DB/#243129   10.87:1   4.5  OK
dark   text  text-muted auf bg                      #AAB5AC/#111A15   8.38:1    4.5  OK
dark   text  text-muted auf surface                 #AAB5AC/#1A241F   7.53:1    4.5  OK
dark   text  text-muted auf surface-2               #AAB5AC/#243129   6.41:1    4.5  OK
dark   text  on-primary auf primary                 #0E1A13/#6FBF92   8.12:1    4.5  OK
dark   text  on-accent auf accent                   #1E1608/#E0A94A   8.47:1    4.5  OK
dark   text  primary auf surface                    #6FBF92/#1A241F   7.25:1    4.5  OK
dark   text  primary auf bg                         #6FBF92/#111A15   8.07:1    4.5  OK
dark   text  success-text auf success-bg            #9BE0B7/#1B3A2A   8.15:1    4.5  OK
dark   text  warning-text auf warning-bg            #F0CF8A/#3D3014   8.58:1    4.5  OK
dark   text  error-text auf error-bg                #FFB4AC/#4A1E1A   8.30:1    4.5  OK
dark   text  error-text auf surface                 #FFB4AC/#1A241F   9.40:1    4.5  OK
dark   text  paper-text auf paper                   #1A1A1A/#FFFFFF   17.40:1   4.5  OK
dark   text  paper-muted auf paper                  #555555/#FFFFFF   7.46:1    4.5  OK
dark   ui    focus auf surface                      #7DB4FF/#1A241F   7.48:1    3    OK
dark   ui    focus auf bg                           #7DB4FF/#111A15   8.33:1    3    OK
dark   ui    border-strong auf surface              #7E9186/#1A241F   4.77:1    3    OK
dark   ui    border-strong auf bg                   #7E9186/#111A15   5.31:1    3    OK
dark   ui    success auf surface                    #5FBF84/#1A241F   7.05:1    3    OK
dark   ui    warning auf surface                    #E0A94A/#1A241F   7.56:1    3    OK
dark   ui    error auf surface                      #F07A70/#1A241F   5.87:1    3    OK
dark   ui    accent auf surface                     #E0A94A/#1A241F   7.56:1    3    OK
dark   ui    success auf success-bg                 #5FBF84/#1B3A2A   5.50:1    3    OK
dark   ui    warning auf warning-bg                 #E0A94A/#3D3014   6.10:1    3    OK
dark   ui    error auf error-bg                     #F07A70/#4A1E1A   5.18:1    3    OK
dark   info  success auf surface                    #5FBF84/#1A241F   7.05:1    -    info
dark   info  warning auf surface                    #E0A94A/#1A241F   7.56:1    -    info
dark   info  error auf surface                      #F07A70/#1A241F   5.87:1    -    info
dark   info  accent auf surface                     #E0A94A/#1A241F   7.56:1    -    info

52 von 54 Prüfungen bestanden, 2 durchgefallen.
```
