# GitHub, Branches und tägliche Qualitätskontrolle

## 1. Repository privat stellen (empfohlen, vor dem ersten Push)

Das Repository `cw-glitch141/mtg_sniper_2.1` war am 04.11.2026 **öffentlich** abrufbar. Es enthält zwar keine
Zugangsdaten und keine Datenbank, aber eine gespeicherte Cardmarket-Seite als Testvorlage mit Namen fremder Verkäufer
und Cardmarket-Skripten (`extension/sample.html`, `extension/test/…_files/`). Deshalb:

GitHub → Repository → **Settings → General → Danger Zone → Change repository visibility → Private**.

## 2. Was nie ins Repository gehört

Das stellt `.gitignore` sicher: `.env` (Tokens), `data/` (Datenbank mit Einkaufs- und Verkaufsdaten, Logs, Berichte,
Sicherungen), `*.sqlite*`, `*.zip`, `node_modules/`, `web/dist/`, `*.pem`/`*.key`.

Vor jedem Push prüfen:

```powershell
git status --short
git ls-files | Select-String -Pattern '\.env$|sqlite|\.zip$|\.log$'
```

Die zweite Zeile muss eine leere Ausgabe liefern.

Falls doch einmal ein Secret committet wurde: Das Secret beim Anbieter **sofort erneuern** (Token neu erzeugen).
Danach die Historie bereinigen, bevor gepusht wird. Ein nachträglicher `.gitignore`-Eintrag reicht nicht.

Hinweis zum ersten Commit: Er enthält noch `backup/mtg-deal-sniper-v1.1.0.zip` (1 MB, eigener Code der Version 1.1,
keine Zugangsdaten). Der zweite Commit nimmt die Datei aus dem Tracking. Soll sie auch aus der Historie verschwinden,
vor dem ersten Push einmalig ausführen:

```powershell
git switch main
git rebase -i --root   # beim ersten Commit "edit", dann: git rm --cached backup/mtg-deal-sniper-v1.1.0.zip; git commit --amend; git rebase --continue
```

## 3. Branches und Pull Requests

- `main` = stabil. Neue Arbeit in `feature/<thema>` oder `fix/<thema>`, dann Pull Request nach `main`.
- Pull Requests nutzen die Vorlage (`.github/pull_request_template.md`) mit Zweck, Story, Tests, Risiken, Migration,
  Rollback und Datenquellen.
- Versionen taggen: `git tag v2.2.0` und `git push origin v2.2.0`. Änderungen stehen in `CHANGELOG.md`.

Erster Push (einmalig, danach genügt `git push`):

```powershell
cd C:\Users\chris\mtg-deal-sniper
git push -u origin main
git push -u origin feature/live-deal-radar
```

Danach auf GitHub einen Pull Request `feature/live-deal-radar` → `main` öffnen.

## 4. Pflicht-Checks und Branch-Protection

Der Workflow `.github/workflows/ci.yml` führt `npm run typecheck`, `npm test` und `npm run build` bei jedem Push und
Pull Request aus, außerdem nachts.

Branch-Protection einschalten: Settings → Branches → Add rule für `main`:

- „Require a pull request before merging“
- „Require status checks to pass“, Check **CI / checks** auswählen

Bei privaten Repositories ist das je nach GitHub-Tarif nur eingeschränkt verfügbar. Ist es nicht verfügbar,
gilt die Regel organisatorisch: kein Merge ohne grünen CI-Lauf.

## 5. Labels und Backlog-Issues

Mit der GitHub CLI (`winget install GitHub.cli`, danach `gh auth login`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\github-setup.ps1 -Repo cw-glitch141/mtg_sniper_2.1 -Issues
```

Das legt die Labels aus `.github/labels.json` an (`bug`, `data-quality`, `api`, `live-listings`, `profit`,
`regression`, `security`, `usability`, `blocked-by-provider`) und erzeugt die Backlog-Issues B-1 bis B-5 aus
`docs/user-stories.md`.

## 6. Tägliche Verbesserung = messen, nicht automatisch umbauen

`scripts/daily-quality.ps1` führt Typprüfung und Tests aus und erzeugt den Qualitätsbericht unter
`data/reports/quality-JJJJ-MM-TT.md`. Der Bericht erscheint auch im Dashboard unter Live-Radar.

Er enthält Datenfrische, Feed-Ausfälle, Teststatus, Signalanzahl, Fehlalarm-Indikatoren, Trends und priorisierte
Vorschläge. Er ändert **nie** Code, Einstellungen oder Daten.

Täglich um 07:30 einrichten (einmalig, als normaler Benutzer):

```powershell
schtasks /Create /SC DAILY /ST 07:30 /TN "MTG Deal Sniper Qualitaetsbericht" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\mtg-deal-sniper\scripts\daily-quality.ps1\""
```

Umsetzungen aus dem Bericht laufen wie jede andere Änderung über Branch, Pull Request und grüne Checks.
Es wird nichts ungeprüft auf das produktive System gespielt.
