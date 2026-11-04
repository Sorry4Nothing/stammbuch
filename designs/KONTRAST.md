# Kontrastmessung

Gemessen mit `node designs/contrast.mjs` (liest `tokens.css`, WCAG 2.x, relative Luminanz). Schwellen: Normaltext 4.5, grosser Text und UI-Komponenten 3.0. Art `info` wird nur ausgegeben und nicht bewertet. Das Skript endet mit Exit-Code 1, solange eine Prüfung durchfällt.

```text
Theme  Art   Paar                                   Farben            Kontrast  Min  Ergebnis
light  text  text auf bg                            #1F2A24/#F7F5F0   13.62:1   4.5  OK
light  text  text auf surface                       #1F2A24/#FFFFFF   14.84:1   4.5  OK
light  text  text auf surface-2                     #1F2A24/#E9E3D3   11.59:1   4.5  OK
light  text  text-muted auf bg                      #4A554D/#F7F5F0   7.14:1    4.5  OK
light  text  text-muted auf surface                 #4A554D/#FFFFFF   7.78:1    4.5  OK
light  text  text-muted auf surface-2               #4A554D/#E9E3D3   6.08:1    4.5  OK
light  text  on-primary auf primary                 #FFFFFF/#2F6B4F   6.29:1    4.5  OK
light  text  on-accent auf accent                   #1F2A24/#C8873A   4.93:1    4.5  OK
light  text  primary auf surface                    #2F6B4F/#FFFFFF   6.29:1    4.5  OK
light  text  primary auf bg                         #2F6B4F/#F7F5F0   5.78:1    4.5  OK
light  text  success-text auf success-bg            #1B5E38/#DCEBDD   6.27:1    4.5  OK
light  text  warning-text auf warning-bg            #6B4400/#F6E7C1   6.98:1    4.5  OK
light  text  error-text auf error-bg                #8C1D18/#F6DAD6   6.91:1    4.5  OK
light  text  error-text auf surface                 #8C1D18/#FFFFFF   9.11:1    4.5  OK
light  text  paper-text auf paper                   #111111/#FFFFFF   18.88:1   4.5  OK
light  text  paper-muted auf paper                  #555555/#FFFFFF   7.46:1    4.5  OK
light  ui    focus auf surface                      #1B5FB5/#FFFFFF   6.27:1    3    OK
light  ui    focus auf bg                           #1B5FB5/#F7F5F0   5.75:1    3    OK
light  ui    border-strong auf surface              #76725F/#FFFFFF   4.84:1    3    OK
light  ui    border-strong auf bg                   #76725F/#F7F5F0   4.44:1    3    OK
light  ui    success auf surface                    #1E8E5A/#FFFFFF   4.14:1    3    OK
light  ui    warning auf surface                    #B7791F/#FFFFFF   3.64:1    3    OK
light  ui    error auf surface                      #C0392B/#FFFFFF   5.44:1    3    OK
light  ui    accent auf surface                     #C8873A/#FFFFFF   3.01:1    3    OK
light  ui    success auf success-bg                 #1E8E5A/#DCEBDD   3.35:1    3    OK
light  ui    warning auf warning-bg                 #B7791F/#F6E7C1   2.97:1    3    DURCHGEFALLEN
light  ui    error auf error-bg                     #C0392B/#F6DAD6   4.12:1    3    OK
light  info  success auf surface                    #1E8E5A/#FFFFFF   4.14:1    -    info
light  info  warning auf surface                    #B7791F/#FFFFFF   3.64:1    -    info
light  info  error auf surface                      #C0392B/#FFFFFF   5.44:1    -    info
light  info  accent auf surface                     #C8873A/#FFFFFF   3.01:1    -    info
dark   text  text auf bg                            #E8EDE9/#101713   15.36:1   4.5  OK
dark   text  text auf surface                       #E8EDE9/#19231D   13.64:1   4.5  OK
dark   text  text auf surface-2                     #E8EDE9/#243129   11.46:1   4.5  OK
dark   text  text-muted auf bg                      #AAB5AC/#101713   8.59:1    4.5  OK
dark   text  text-muted auf surface                 #AAB5AC/#19231D   7.63:1    4.5  OK
dark   text  text-muted auf surface-2               #AAB5AC/#243129   6.41:1    4.5  OK
dark   text  on-primary auf primary                 #0E1A13/#6FBF98   8.15:1    4.5  OK
dark   text  on-accent auf accent                   #1E1608/#E0A662   8.35:1    4.5  OK
dark   text  primary auf surface                    #6FBF98/#19231D   7.37:1    4.5  OK
dark   text  primary auf bg                         #6FBF98/#101713   8.30:1    4.5  OK
dark   text  success-text auf success-bg            #9BE0B7/#1B3A2A   8.15:1    4.5  OK
dark   text  warning-text auf warning-bg            #F0CF8A/#3D3014   8.58:1    4.5  OK
dark   text  error-text auf error-bg                #FFB4AC/#4A1E1A   8.30:1    4.5  OK
dark   text  error-text auf surface                 #FFB4AC/#19231D   9.52:1    4.5  OK
dark   text  paper-text auf paper                   #111111/#FFFFFF   18.88:1   4.5  OK
dark   text  paper-muted auf paper                  #555555/#FFFFFF   7.46:1    4.5  OK
dark   ui    focus auf surface                      #7DB4FF/#19231D   7.58:1    3    OK
dark   ui    focus auf bg                           #7DB4FF/#101713   8.53:1    3    OK
dark   ui    border-strong auf surface              #7E9186/#19231D   4.83:1    3    OK
dark   ui    border-strong auf bg                   #7E9186/#101713   5.44:1    3    OK
dark   ui    success auf surface                    #4CC38A/#19231D   7.30:1    3    OK
dark   ui    warning auf surface                    #E3B341/#19231D   8.30:1    3    OK
dark   ui    error auf surface                      #F26D5F/#19231D   5.49:1    3    OK
dark   ui    accent auf surface                     #E0A662/#19231D   7.54:1    3    OK
dark   ui    success auf success-bg                 #4CC38A/#1B3A2A   5.63:1    3    OK
dark   ui    warning auf warning-bg                 #E3B341/#3D3014   6.61:1    3    OK
dark   ui    error auf error-bg                     #F26D5F/#4A1E1A   4.78:1    3    OK
dark   info  success auf surface                    #4CC38A/#19231D   7.30:1    -    info
dark   info  warning auf surface                    #E3B341/#19231D   8.30:1    -    info
dark   info  error auf surface                      #F26D5F/#19231D   5.49:1    -    info
dark   info  accent auf surface                     #E0A662/#19231D   7.54:1    -    info

53 von 54 Prüfungen bestanden, 1 durchgefallen.
```

## Auswertung

- **Ergebnis:** 53 von 54 bewerteten Prüfungen bestehen, eine fällt durch (Exit-Code 1). Alle Textpaare (4.5) bestehen in beiden Themes, ebenso Papier.
- **Durchfall:** `warning` (`#B7791F`) als Rand auf `warning-bg` (`#F6E7C1`) im hellen Theme: 2.97 : 1, Soll 3.0. Betroffen ist nur der Rand der Warn-Meldung. Der Text darin (`warning-text` auf `warning-bg`, 6.98 : 1) und das Symbol auf Fläche (3.64 : 1) bestehen. Die Palette aus `projektplan.md` wurde nicht geändert. Vorschlag für später: Meldungsrand der Warnung auf `warning-text` setzen oder `warning` hell abdunkeln.
- **Knapp:** `accent` (`#C8873A`) auf Fläche hell 3.01 : 1. Zulässig nur als Markierung (Punkt, Linie), nie als Text. Text auf Akzentfläche (`on-accent`) hat 4.93 : 1.
- **Statusfarben nie als Text:** hell erreichen `success` 4.14, `warning` 3.64 und `accent` 3.01 auf Weiss keine 4.5. Status als Text immer über `*-text` auf `*-bg` (6.3 bis 9.1 : 1). Das entspricht der Vorgabe im Artifact («Fläche, Linie, Symbol, kein Text»). Dazu immer ein Symbol oder Wort, nie nur Farbe.
- **Feldrand hell auf Seitengrund:** `border-strong` auf `bg` 4.44 : 1 (Soll 3.0), also in Ordnung.
- **Dunkel:** alle Paare mit deutlichem Abstand (kleinster UI-Wert 4.78 : 1, kleinster Textwert 6.41 : 1).
- **Abweichung zum Artifact:** Die Zahlen im Artifact (Gruppe 11.1) beruhen auf dessen eigenen Hex-Werten und weichen daher leicht ab. Hier gelten die Werte der Palette aus `projektplan.md`.
