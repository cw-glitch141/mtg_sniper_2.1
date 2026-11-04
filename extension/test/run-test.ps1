# MTG Deal Sniper – Tests gegen sample.html und Popup (headless Chrome, keine Netzwerkzugriffe)
#
# Aufruf (im Projektordner):  powershell -ExecutionPolicy Bypass -File test\run-test.ps1
# Optional: -AssetsDir "<Pfad zum ..._files-Ordner der gespeicherten Seite>" für einen gestylten Screenshot.
param(
  [string]$AssetsDir = "",
  [string]$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$test = $PSScriptRoot
$utf8 = New-Object Text.UTF8Encoding $false

# ---------------------------------------------------------------------------
# 1. Testseiten bauen
# ---------------------------------------------------------------------------

# Kartenseite: Cardmarket-Skripte entfernen (kein Netzwerk), eigene Skripte einfügen
$html = [IO.File]::ReadAllText("$root\sample.html", [Text.Encoding]::UTF8)
$html = [regex]::Replace($html, '<script\b[^>]*>[\s\S]*?</script>', '')
$inject = @'
<script src="page-seed.js"></script>
<script src="chrome-shim.js"></script>
<link rel="stylesheet" href="../styles.css">
<script src="../parser.js"></script>
<script src="../shared.js"></script>
<script src="../content.js"></script>
<script src="scenario.js"></script>
'@
$html = $html -replace '</body>', "$inject</body>"
[IO.File]::WriteAllText("$test\sample.test.html", $html, $utf8)

# Popup: Startdaten + chrome.storage-Ersatz vor den Extension-Skripten
$popup = [IO.File]::ReadAllText("$root\popup.html", [Text.Encoding]::UTF8)
$popup = $popup.Replace('<script src="parser.js"></script>',
  '<script src="popup-seed.js"></script><script src="chrome-shim.js"></script><script src="../parser.js"></script>')
$popup = $popup.Replace('<script src="shared.js"></script>', '<script src="../shared.js"></script>')
$popup = $popup.Replace('<script src="popup.js"></script>', '<script src="../popup.js"></script><script src="popup-scenario.js"></script>')
[IO.File]::WriteAllText("$test\popup.test.html", $popup, $utf8)

# Assets (CSS/Bilder) der gespeicherten Seite neben die Testkopie legen, falls angegeben
if ($AssetsDir -and (Test-Path -LiteralPath $AssetsDir)) {
  $name = Split-Path -Leaf $AssetsDir
  if (-not (Test-Path -LiteralPath "$test\$name")) {
    Copy-Item -LiteralPath $AssetsDir -Destination "$test\$name" -Recurse
    Get-ChildItem -LiteralPath "$test\$name" -Filter *.js -Recurse | Remove-Item -Force   # Skripte nicht nötig
  }
}

# ---------------------------------------------------------------------------
# 2. Headless Chrome
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'   # Chrome schreibt Statusmeldungen nach stderr
function FileUrl($p) { 'file:///' + ($p -replace '\\', '/') }
$profile = Join-Path $env:TEMP 'mtgds-test-profile'
$common = @('--headless=new', '--disable-gpu', '--no-first-run', "--user-data-dir=$profile", '--virtual-time-budget=5000', '--log-level=3')

$url = FileUrl "$test\sample.test.html"
$dom = & $Chrome @common --dump-dom $url | Out-String
& $Chrome @common '--window-size=1400,1500' "--screenshot=$test\screenshot.png" $url | Out-Null
foreach ($tab in 'watch', 'bundle', 'settings', 'import', 'dashboard') {
  & $Chrome @common '--window-size=400,860' "--screenshot=$test\popup-$tab.png" ((FileUrl "$test\popup.test.html") + "#$tab") | Out-Null
}

$m = [regex]::Match($dom, '<pre id="mtgds-test-output"[^>]*>([\s\S]*?)</pre>')
if (-not $m.Success) { throw 'Testausgabe nicht gefunden – sample.test.html in Chrome mit DevTools öffnen.' }
$json = [Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
[IO.File]::WriteAllText("$test\result.json", $json, $utf8)
$r = $json | ConvertFrom-Json

# ---------------------------------------------------------------------------
# 3. Ausgabe
# ---------------------------------------------------------------------------
$fail = @($r.unit | Where-Object { -not $_.ok })
"== Unit-Tests: $(@($r.unit).Count - $fail.Count) von $(@($r.unit).Count) OK =="
$r.unit | Group-Object group | ForEach-Object { '  {0,-10} {1}/{2}' -f $_.Name, @($_.Group | Where-Object ok).Count, $_.Count }
$fail | ForEach-Object { "  FAIL [$($_.group)] $($_.name): erwartet $($_.expected | ConvertTo-Json -Compress), erhalten $($_.got | ConvertTo-Json -Compress)" }
""
"== Marktwerte ($($r.cardName), Schluessel $($r.pageKey)) =="
"Trend $($r.market.trend) | 30T $($r.market.avg30) | 7T $($r.market.avg7) | 1T $($r.market.avg1) EUR"
""
"== Angebote ($(@($r.offers).Count)), Standardeinstellungen inkl. Porto =="
$i = 0
$r.offers | ForEach-Object {
  $i++
  [pscustomobject]@{
    '#' = $i
    Verkaeufer = $_.seller
    Typ = $_.sellerType
    Verk = $_.sales
    Zust = $_.condition
    Spr = $_.languageLabel
    Foil = $(if ($_.foil) {'ja'} else {''})
    Preis = '{0:N2}' -f $_.price
    Porto = '{0:N2}' -f $_.ship
    Gesamt = '{0:N2}' -f $_.eff
    'Rabatt%' = '{0:N1}' -f $_.discountTrend
    Bewertung = $(if ($_.isDeal) {'DEAL'} elseif ($_.eligible) {'passt'} else {$_.reason})
  }
} | Format-Table -AutoSize -Property '#', Verkaeufer, Typ, Verk, Zust, Spr, Foil, Preis, Porto, Gesamt, 'Rabatt%', Bewertung | Out-String -Width 250
"== Phase A: nach dem Laden =="
$r.phaseA.panel
"Watchlist-Treffer-Zeilen: $($r.phaseA.watchHitRows -join ', ')"
""
"== Phase B: nach simuliertem Nachladen einer Zeile mit 69,00 EUR =="
$r.phaseB.panel
"Deal-Zeilen: $($r.phaseB.dealRows -join ', ')"
"Badges: $($r.phaseB.badges -join ' // ')"
""
"== Speicher =="
"sync-Schluessel nach Migration: $($r.storage.syncKeys -join ', ')"
"Watchlist-Eintrag: $($r.storage.watchEntry | ConvertTo-Json -Compress)"
"Preisverlauf: $(@($r.storage.histEntries).Count) Eintraege, letzter: $($r.storage.histEntries[-1] | ConvertTo-Json -Compress)"
"Schnappschuss: $($r.storage.snapOffers) Angebote gespeichert"
""
"== Dashboard-Uebertragung (2.0) =="
"Nachrichten an Background: $($r.dashboard.messages) | erste Sendung: $($r.dashboard.firstCount) Angebote | alle mit Produkt-ID 152: $($r.dashboard.allHaveProductId)"
"Nachgeladene Zeile erneut gesendet: $($r.dashboard.lastContainsSimulatedRow)"
"Erstes Angebot: $($r.dashboard.firstOffer | ConvertTo-Json -Compress)"
"Netto-Badges: $($r.phaseB.evalBadges -join ' // ')"
$dashOk = $r.dashboard.messages -ge 2 -and $r.dashboard.allHaveProductId -and $r.dashboard.lastContainsSimulatedRow -and @($r.phaseB.evalBadges).Count -ge 2
"Dashboard-Pruefung: $(if ($dashOk) {'OK'} else {'FEHLER'})"
""
"Screenshots: $test\screenshot.png, popup-watch.png, popup-bundle.png, popup-settings.png"
