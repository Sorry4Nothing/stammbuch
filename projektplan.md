# Projektplan: Stammbuch (Verbands-/Mitgliederverwaltung mit Buchhaltung)

Stand: 2026-11-02 · Status: Entwurf zur Freigabe. Nichts davon ist gebaut.
Kennzeichnung: **[Vorgabe]** = von Dir gesagt. **[Annahme]** = meine Vermutung, bitte korrigieren. **[Offen]** = Frage an Dich (siehe Abschnitt 8).

## 1. Idee in einem Satz

Eine Web-Anwendung, die sich wie ein kleiner Desktop-PC im Browser verhält (mehrere Tabs/Fenster), in der eine Organisation ihre Mitglieder, Firmen, Rechnungen, Debitorenbuchhaltung, Massenmails und Events verwaltet. Das Produkt wird nicht verkauft, sondern gegen Lizenzgebühr bereitgestellt. **[Vorgabe]**

## 2. Ziele, Nicht-Ziele, Anti-Ziele

**Ziele**
- Alles Tagesgeschäft einer Mitgliederorganisation an einem Ort, ohne zwischen Programmen zu wechseln.
- Mail-Aktionen einmal vorbereiten, Empfängerliste wählen, absenden oder planen.
- Buchhaltung für Debitoren vollständig (Rechnung bis Auswertung), mit Bankimport.
- Datensparsamkeit: Event-Daten verschwinden 24 Stunden nach dem Event.

**Nicht-Ziele** **[Vorgabe]**
- Kein zentrales Datenregister/CRM als eigener Kontakte-Pool. Adresslisten entstehen aus Mitgliedern/Gruppen oder werden von Hand für den Versand angelegt. **[Annahme: so gemeint]**
- Keine Kreditoren-, Lohn- oder Anlagenbuchhaltung. Nur Debitoren, aber vollständig.

**Anti-Ziele (wären ein Fehlschlag, auch wenn alles "funktioniert")** **[Annahme]**
- Mails, die im Dark Mode des Senders dunkel oder unleserlich beim Empfänger ankommen.
- Versehentlicher Massenversand (kein Test-/Bestätigungsschritt).
- Buchungen, die sich nachträglich still ändern lassen.
- Ein Mandant sieht Daten eines anderen Mandanten.

## 3. Module

### 3.1 Anmeldung und Sicherheit
- Login mit Zwei-Faktor-Authentifizierung für alle berechtigten Personen. **[Vorgabe]**
- 2FA-Methode: TOTP-App als Standard, Wiederherstellungscodes. **[Annahme]** (E-Mail-Code, Passkeys optional später)
- Keine Rollen mit beschränkten Rechten: Wer Zugriff hat, hat Vollzugriff. Zusätzlich ein Chef-Admin (Anbieter), siehe Abschnitt 8. **[Vorgabe]**
- Protokoll (Audit-Log) für sicherheits- und buchhaltungsrelevante Aktionen. **[Annahme]**

### 3.2 Personen- und Gruppenverwaltung
- Personen als **Einzelmitglieder** oder **Firmenmitglieder**. **[Vorgabe]**
- Admin kann Gruppen selbst anlegen, umbenennen, auflösen. **[Vorgabe]**
- **Eine Person hat höchstens eine Gruppe.** Technisch erzwungen (Datenbank-Constraint), nicht nur in der Oberfläche. **[Vorgabe]**

### 3.3 Firmenregister
- Firmen erfassen sich einmal. Bei der Registrierung eines Firmenmitglieds wählt man die Firma aus einer Liste, statt sie neu einzutippen. **[Vorgabe]**
- Firmen können sich selbst registrieren; Freigabe durch Admin. **[Annahme]**
- Duplikat-Erkennung (gleicher Name/UID/MwSt-Nr.). **[Annahme]**

### 3.4 Multi-Tab-Oberfläche ("kleiner PC")
- Jede Funktion (Person, Rechnung, Mail-Entwurf, Kalender …) öffnet in einem eigenen Tab. Man wechselt zwischen offenen Tabs, ohne Kontext zu verlieren. **[Vorgabe]**
- Ungespeicherte Eingaben bleiben im Tab erhalten; Warnung beim Schliessen. **[Annahme]**
- Light-/Dark-Umschalter per Knopf. **[Vorgabe]**

### 3.5 Rechnungswesen und Buchhaltung (nur Debitoren, aber komplett)
- Rechnungen erstellen, versenden, mahnen, stornieren/gutschreiben. **[Vorgabe]**
- Debitorenbuchhaltung von A bis Z: Kontenplan, Buchungen, Offene Posten, Zahlungszuordnung, Periodenabschluss, Auswertungen (Offene-Posten-Liste, Debitorenliste, Saldenliste, Erfolgsrechnung/Bilanz soweit Debitoren betroffen, MwSt-Abrechnung). **[Vorgabe: "komplettes Spektrum"], Umfang [Offen]**
- Zahlungsimport: Bankdateien **CAMT.053** (Kontoauszug) und **CAMT.054** (Zahlungsavis) einlesen, automatisch Rechnungen zuordnen, Rest manuell. **[Vorgabe]**
- Unveränderbarkeit: Gebuchtes wird nur per Gegenbuchung korrigiert. **[Annahme, gesetzlich üblich]**
- Rechnungs-PDF mit Zahlungsteil. Bei Schweizer Betrieb: QR-Rechnung. **[Offen: Land]**

### 3.6 Mail-Programm
- Mails schreiben und versenden, Einzel- und **Multiversand**. **[Vorgabe]**
- **Versandplan**: Versand zu einem späteren Zeitpunkt festlegen. **[Vorgabe]**
- Anhänge: eine Datei einmal anhängen, geht mit jeder Mail des Versands raus. **[Vorgabe]**
- Adresslisten: von Hand gebaut oder aus Gruppen/Mitgliedern gezogen. **[Vorgabe]**
- Platzhalter (Anrede, Name, persönlicher Antwortlink). **[Annahme]**
- Mail-Inhalt ist **immer helles Papier**: Der Editor zeigt im Dark Mode ein weisses Blatt mit dunkler Schrift, und der Versand ist unabhängig vom Theme des Absenders. **[Vorgabe]**
- Testversand an sich selbst und Bestätigung vor Massenversand. **[Annahme]**
- "Komplettes Mail-Programm": Ob auch Posteingang (IMAP) gemeint ist oder nur Versand/Planung, ist **[Offen]**.

### 3.7 Kalender, Events, Einladungen
- Kalender mit planbaren Events. **[Vorgabe]**
- Einladung aus einem Event erzeugen und über das Mail-Modul versenden. **[Vorgabe]**
- Anmeldeschluss pro Event/Einladung definierbar. **[Vorgabe]**
- Rückmeldungen der Eingeladenen (Zusage/Absage, evtl. Begleitung, Hinweise) sammeln, Teilnehmerliste live. **[Vorgabe]**
- Export der Teilnehmerliste als **Excel (.xlsx)** mit ansprechendem Design. **[Vorgabe]**
- **Löschung 24 Stunden nach dem Event**: alle zu diesem Event gehörenden Daten (Teilnehmerliste, Antworten, Anhänge, Mail-Entwürfe). **[Vorgabe]** Abgrenzung zur Buchhaltung siehe 6.

### 3.8 Lizenzierung und Betrieb
- Bereitstellung gegen Lizenzgebühr. **[Vorgabe]**
- Alle Kunden laufen auf einer gemeinsamen Installation mit getrennten Daten (Mandantenfähigkeit), siehe Abschnitt 7. **[Entschieden]**

## 4. Design

Hell und Dunkel, per Knopf umschaltbar **[Vorgabe]**. Farbvorschläge stehen in der Chat-Antwort (keine Bildschirmentwürfe, wie gewünscht). Regeln, unabhängig von der Wahl:
- Farben nur als Variablen (Design-Tokens), nie fest im Code.
- Mail- und Rechnungs-Vorschau immer weisses Papier mit dunkler Schrift.
- Statusfarben (bezahlt, offen, überfällig, Fehler) in beiden Themes mit ausreichendem Kontrast. Kontrastwerte werden beim Bau gemessen. **[Annahme]**

Festlegungen (2026-11-02):
- **Geräte:** reine Webseite für den PC. Kein Handy, kein Tablet als Ziel. **[Vorgabe]** Mindestbreite etwa 1280 px. Kein Aufwand für kleine Bildschirme.
- **Aufbau:** Seitenleiste links mit den Modulen, Tab-Leiste oben, Arbeitsfläche darunter. **[Meine Entscheidung]**
- **Dichte:** kompakt, Listen mit hunderten bis tausenden Zeilen (virtualisiert, mit Suche und Filtern). **[Meine Entscheidung]**
- **Schrift:** Inter, selbst gehostet (kein Google Fonts). **[Meine Entscheidung]**
- **Tastatur:** Kürzel für Suchen, Neu, Speichern, Tab wechseln und schliessen. **[Meine Entscheidung]**
- **Barrierefreiheit:** Kontrast mindestens WCAG AA, alles per Tastatur bedienbar. **[Meine Entscheidung]**
- **Kundenlogo und Absenderdaten auf Rechnung und Mail:** Oberfläche bleibt für alle gleich, nur Dokumente tragen das Logo. **[Vorgabe, bestätigt]**

## 5. Vorgeschlagene Reihenfolge **[Annahme]**

| Phase | Inhalt | Warum jetzt |
|---|---|---|
| 0 | Fundament: Projekt, Datenbank, Login + 2FA, Rollen, Mandantenmodell, Oberfläche mit Tabs, Theme-Umschalter | Alles baut darauf auf |
| 1 | Personen, Gruppen (max. 1), Firmenregister, Registrierung | Rechnungen, Mails und Events brauchen Personen |
| 2 | Rechnungen + Debitorenbuchhaltung (Kern) | Kern des Lizenzwerts |
| 3 | CAMT.053/.054-Import + Zuordnung | Schliesst den Zahlungskreis |
| 4 | Mail: Versand, Listen, Anhänge, Planung | Vor Events nötig |
| 5 | Kalender, Events, Einladungen, Rückmeldungen, Excel, 24h-Löschung | Nutzt Mail + Personen |
| 6 | Auswertungen komplett, Abschluss, Feinschliff | |
| 7 | Lizenzverwaltung, Betrieb, Backups, Doku | Vor dem ersten Kunden |

Jede Phase wird ein eigenes Teilprojekt mit eigener Beschreibung und eigenem Plan. Das Ganze ist zu gross für einen einzigen Bauplan.

## 6. Spannungen, die Du entscheiden musst

1. **24-Stunden-Löschung gegen Aufbewahrungspflicht.** Rechnungen und Buchungen müssen je nach Land 10 Jahre bleiben. Event-Daten dürfen verschwinden, Rechnungen nicht. Ich lese Deine Vorgabe so: Teilnehmerliste, Antworten, Event-Anhänge werden gelöscht; Rechnungen und Buchhaltung bleiben. **[Annahme]**
2. **Kein Datenregister gegen Firmenregister.** Das Firmenregister ist eine Auswahlliste für Mitglieder, kein allgemeiner Kontaktpool. **[Annahme]**
3. **Eine Gruppe pro Person gegen Mail-Listen.** Listen dürfen mehrere Gruppen kombinieren, auch wenn eine Person nur in einer Gruppe ist. **[Annahme]**

## 7. Technik (Stand 2026-11-02; Auswahl nach bester Eignung, nicht nach Einfachheit)

Grundsatz: Es gibt genug Zeit zum Bauen, also zählt, was am besten passt.

**Aufbau**
- **Sprache:** TypeScript durchgehend, Typen zwischen Oberfläche und Server geteilt.
- **Oberfläche:** React als Single-Page-App (Vite) mit eigener Tab-Verwaltung ("kleiner PC"). Kein Next.js: Die App liegt hinter dem Login, braucht kein SEO und keine Server-Seitenerzeugung. Eine reine SPA trennt die Oberfläche sauber vom Server.
- **Server (API):** eigener Dienst mit Fastify oder NestJS (Wahl beim Start von Phase 1). Er enthält die Geschäftsregeln der Buchhaltung.
- **Worker:** eigener Prozess für Hintergrundarbeit: IMAP-Synchronisation (dauerhafte Verbindungen), geplanter Mailversand, CAMT-Import, 24-Stunden-Löschung, Mahnläufe. Das ist der Grund gegen Next.js: Es ist für dauerhaft laufende Prozesse die falsche Basis.
- **Warteschlange:** in PostgreSQL (z. B. pg-boss). Kein weiterer Dienst.
- **Datenzugriff:** SQL-nah (Kysely oder Drizzle), Migrationen als SQL. Kein Prisma: Zeilensicherheit (RLS) und Buchhaltungs-Constraints lassen sich damit schlechter ausdrücken. **[Vorschlag]**

**Datenbank**
- PostgreSQL, **kostenpflichtig und verwaltet** bei einem Schweizer Anbieter, mit automatischen Backups, Point-in-Time-Recovery und Replikat. Keine Free-Version, keine Gratis-Dienste im Betrieb.
- Mandantentrennung in der Datenbank erzwungen (Row-Level-Security mit Kunden-ID in jeder Tabelle). **[Vorschlag, im Datenmodell final festlegen]**
- Geldbeträge als ganzzahlige Rappen oder NUMERIC, nie Fliesskomma. Buchungen nur anhängen, nie überschreiben (Storno statt Änderung).
- Datenbank erzwingt "max. eine Gruppe pro Person".

**Anmeldung**
- Passwort, TOTP (Authenticator-App), Wiederherstellungscodes. Pflicht für alle Benutzer.
- **Chef-Admin kann die Zwei-Faktor-Authentifizierung eines Benutzers zurücksetzen**, damit sich niemand aussperrt. Das ist nur Zurücksetzen des zweiten Faktors, keine Passwortübernahme. Der Benutzer muss beim nächsten Login neu einrichten. Jede Zurücksetzung wird protokolliert und per Mail an den Benutzer gemeldet. Das Chef-Admin-Konto selbst braucht einen Notfallweg (zweiter Chef-Admin oder dokumentiertes Verfahren). **[Vorschlag]**

**Mail**
- IMAP/SMTP über das Kundenpostfach, Zugangsdaten verschlüsselt. Kein OAuth (siehe Mailanbindung).

**Dokumente**
- PDF serverseitig (Rechnungen, QR-Zahlteil, Mahnungen, Berichte). Excel über eine Bibliothek. Beides bestätigt.

**Betrieb**
- Hosting in der Schweiz. **Entscheidung (2026-11-02, von Dir an mich delegiert):** ein Cloud-Server (VPS) in der Schweiz mit Docker für Oberfläche, API und Worker, dazu die Datenbank getrennt als verwalteter Dienst. Gründe: Der Worker braucht dauerhaft laufende Prozesse (kein Webhosting möglich); für 10 bis 50 Kunden ist Kubernetes unnötig. Zwei Server mit Lastverteiler erst bei Bedarf. Anbieter für Server und Datenbank werden später gewählt (Kriterien: Standort Schweiz, Backups mit Point-in-Time-Recovery, Vertrag zur Auftragsbearbeitung, Support).
- **Umfang:** 10 bis höchstens 50 Kunden in den ersten 2 Jahren. **Entscheidung:** eine gemeinsame Datenbank und ein Schema, Kunden-ID in jeder Tabelle, Trennung per Row-Level-Security. Reicht für diese Grösse, Änderungen am Datenmodell laufen einmal statt pro Kunde. Export und Löschung eines Kunden bei Vertragsende gehen über die Kunden-ID.

## 8. Entscheidungen und offene Punkte

**Entschieden (2026-11-02, von Dir)**
- **Land: Schweiz.** Folgt daraus (meine Annahmen): Währung CHF, Schweizer MwSt, QR-Rechnung mit QR-IBAN/Referenz, CAMT-Import mit QR-Referenz-Zuordnung, Aufbewahrung von Buchhaltungsunterlagen 10 Jahre.
- **Getrennte Kunden.** Jeder Kunde (Organisation) bekommt dieselbe Software im selben Aussehen, sieht aber ausschliesslich die eigenen Daten. Ob technisch eine gemeinsame Installation mit strikt getrennten Mandanten oder je Kunde eine eigene Installation läuft, entscheide ich später mit Dir (Empfehlung: eine Installation, getrennte Mandanten, Trennung in der Datenbank erzwungen).
- **Mail: voller Mailverkehr.** Senden, Planen, Multiversand und zusätzlich Posteingang: Mails empfangen, lesen und normal beantworten (IMAP/SMTP bzw. Provider-Anbindung).
- **Buchhaltung: volles Programm.** Hunderte bis Tausende Mitglieder pro Kunde. Muss zuverlässig laufen, übersichtlich und verständlich sein. Das ist ein harter Qualitätsanspruch (Suche, Filter, Sammelverarbeitung, schnelle Listen).
- **24-Stunden-Löschung, eng gefasst.** Gelöscht wird nur: der Event-Eintrag im Kalender und die Zu-/Absagen dazu (Teilnehmerliste). Rechnungen und Buchhaltung werden nie angefasst. Zu Events gibt es keine Rechnungen. Die Mails zum Event bleiben zunächst liegen.
- **Farben: Palette "Waldgrün und Sand" (Nr. 3), festgelegt.** Hell: Hintergrund #F7F5F0, Fläche #FFFFFF, Text #1F2A24, Primär #2F6B4F, Akzent #C8873A, Rand #E1DDD2. Dunkel: Hintergrund #101713, Fläche #19231D, Text #E8EDE9, Primär #6FBF98, Akzent #E0A662, Rand #2B3A31. Status hell: Erfolg #1E8E5A, Warnung #B7791F, Fehler #C0392B. Status dunkel: #4CC38A, #E3B341, #F26D5F. Mail- und Rechnungspapier immer #FFFFFF mit Text #111111.
- **2FA: Einmalcode (OTP) ist Pflicht.** Umsetzung als TOTP (Authenticator-App) mit Wiederherstellungscodes. **[Annahme]** für alle Benutzer verpflichtend, keine Anmeldung ohne zweiten Faktor.

- **Benutzer und Rechte (2026-11-02).** Im System arbeitet meist eine Person (Rechnungswesen), eventuell ein bis zwei weitere. Wer Zugriff hat, hat Vollzugriff: keine Rollen mit beschränkten Rechten. Zusätzlich gibt es einen **Chef-Admin**, der weitere Kunden anlegen kann (zum Beispiel für andere Aktuare). Mitglieder melden sich nicht an. **[Annahme]**
- **Mailanbindung.** Jeder Kunde hat bereits ein eigenes Postfach und trägt die Zugangsdaten selbst ein. Die Software sendet und empfängt darüber und hält den Stand synchron (IMAP/SMTP). Zugangsdaten werden verschlüsselt gespeichert. **Entscheidung (2026-11-02):** nur IMAP/SMTP mit Passwort oder App-Passwort, kein OAuth. **Einschränkung:** Postfächer, die nur OAuth erlauben (typisch Microsoft 365 und Google Workspace), sind damit nicht anbindbar. Kunden brauchen ein Postfach mit Passwort-Anmeldung, zum Beispiel bei einem Schweizer Mail-Anbieter. Das gehört in die Lizenzbedingungen.
- **Sprache:** nur Deutsch. **Meine Entscheidung:** Texte trotzdem in Sprachdateien ablegen, damit Französisch später ohne Umbau möglich ist.
- **Datenschutz (nDSG, in Kraft seit 1.9.2023), Prüfung:**
  - Jeder Kunde ist Verantwortlicher, wir sind Auftragsbearbeiter (Art. 9 nDSG). Mit jedem Kunden braucht es einen Vertrag zur Auftragsbearbeitung als Anhang zum Lizenzvertrag.
  - Hosting in der Schweiz ist nicht Pflicht. Daten im Ausland sind nur erlaubt, wenn das Land ein angemessenes Schutzniveau hat oder Garantien bestehen (Art. 16 nDSG). Schweizer Hosting umgeht diese Prüfung weitgehend, auch Fernzugriff aus dem Ausland zählt aber als Bekanntgabe. **Empfehlung:** Hosting bei einem Schweizer Anbieter, als Verkaufsargument.
  - Buchhaltung: 10 Jahre Aufbewahrung ab Ende des Geschäftsjahres (Art. 958f OR); Daten dürfen nicht unbemerkt veränderbar sein, Zugriffe sind zu protokollieren, Integrität ist regelmässig zu prüfen (GeBüV). Quellen widersprechen sich, ob Zeitstempel und Signaturen nötig sind: vor dem Bau der Buchhaltung mit Treuhänder oder Anwalt klären.
  - Keine Rechtsberatung. Vertrag und GeBüV-Umsetzung von einer Fachperson prüfen lassen.
- **Mitgliedsbeiträge (Sammelrechnung):** hängt vom Kunden ab (2026-11-02). **Meine Entscheidung:** Sammelrechnung als optionales Modul einplanen, pro Kunde ein- oder ausschaltbar.
- **Altdaten-Import:** unbekannt (2026-11-02). Wird vor Phase 2 erneut geklärt. Bis dahin Importfunktion (CSV) nicht eingeplant.

**Offen**
- Chef-Admin: Anbieter (Du) oder Person beim Kunden? **Beantwortet (2026-11-02):** der Chef-Admin bist Du als Anbieter. Hosting läuft bei Deinem Schweizer Anbieter. **Chef-Admin legt Kunden nur an und sieht keine Kundendaten** (2026-11-02).
- Mailspeicher: wie wird Speicherplatz wieder frei (Archivierung, automatische Löschfristen, Grössenlimit pro Kunde)? Später.
- Excel-Export-Design (beim Bau des Event-Moduls).
- Rollen und Rechte im Detail.
- Technik-Stack: bestätigt (Abschnitt 7). Offen nur: Wahl der Anbieter für Server und Datenbank (später).


https://claude.ai/artifact/56VW654FMxXFqpoNbNzAFW#page-dcb81aee8d83
