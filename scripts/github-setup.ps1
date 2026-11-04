<#
  Einmalige GitHub-Einrichtung mit der GitHub CLI (https://cli.github.com), angemeldet über `gh auth login`.
  Legt die Labels aus .github/labels.json an und erzeugt die Backlog-Issues aus docs/user-stories.md.
  Ändert NICHT die Sichtbarkeit des Repositorys und pusht nichts.

  Aufruf:  powershell -ExecutionPolicy Bypass -File scripts\github-setup.ps1 -Repo cw-glitch141/mtg_sniper_2.1 [-Issues]
#>
param([Parameter(Mandatory)][string]$Repo, [switch]$Issues)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) nicht gefunden: https://cli.github.com' }
gh auth status | Out-Null

$vis = gh repo view $Repo --json visibility --jq .visibility
if ($vis -ne 'PRIVATE') { Write-Warning "Repository ist $vis. Empfohlen: privat (Settings → General → Danger Zone → Change visibility)." }

$labels = Get-Content (Join-Path $PSScriptRoot '..\.github\labels.json') -Raw -Encoding utf8 | ConvertFrom-Json
foreach ($l in $labels) { gh label create $l.name --repo $Repo --color $l.color --description $l.description --force | Out-Null; Write-Host "Label: $($l.name)" }

if ($Issues) {
  $items = @(
    @{ t = 'B-1 CardTrader-Feed mit eigenem Token live verifizieren'; l = 'live-listings,api,blocked-by-provider'; b = 'Felder, Linkformat, Rate-Limits und reale Angebots-IDs mit einem echten Lauf bestätigen; mindestens ein beobachtetes neues/reduziertes Angebot dokumentieren (US-04). Siehe docs/datenquellen.md.' },
    @{ t = 'B-2 CardTrader-Versandkosten je Verkäufer statt Schätzung'; l = 'profit,api'; b = 'GET /shipping_methods?username=… auswerten; bis dahin bleibt das Porto eine gekennzeichnete Schätzung.' },
    @{ t = 'B-3 Extension-Tests in CI (Windows-Runner)'; l = 'regression'; b = 'extension/test/run-test.ps1 (headless Chrome) in den CI-Workflow aufnehmen (US-08).' },
    @{ t = 'B-4 eBay-Adapter mit strenger Titelprüfung'; l = 'api,blocked-by-provider'; b = 'Nur mit Produktionszugang zu den Buy-APIs; unklare Varianten → Prüfung, nie Kaufchance.' },
    @{ t = 'B-5 Cardmarket-API, sobald Anträge wieder möglich sind'; l = 'api,blocked-by-provider'; b = 'Derzeit nimmt Cardmarket keine API-Anträge an (help.cardmarket.com/en/cardmarket-api).' }
  )
  foreach ($i in $items) { gh issue create --repo $Repo --title $i.t --label $i.l --body $i.b | Out-Null; Write-Host "Issue: $($i.t)" }
}
