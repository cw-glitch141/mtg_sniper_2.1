<#
  Täglicher Qualitätslauf (US-07): Typprüfung + Tests ausführen, danach den Qualitätsbericht erzeugen.
  Der Lauf ändert NIE Code, Einstellungen oder Nutzerdaten – er misst und schlägt vor.

  Manuell:      powershell -ExecutionPolicy Bypass -File scripts\daily-quality.ps1
  Mit Extension-Tests (headless Chrome):  ... -File scripts\daily-quality.ps1 -WithExtension
  Täglich um 07:30 per Aufgabenplanung einrichten (einmalig, als normaler Benutzer):
    schtasks /Create /SC DAILY /ST 07:30 /TN "MTG Deal Sniper Qualitaetsbericht" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\mtg-deal-sniper\scripts\daily-quality.ps1\""
  Ergebnis: data\reports\quality-JJJJ-MM-TT.md (+ Eintrag im Dashboard unter Live-Radar).
#>
param([switch]$WithExtension)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $env:Path = "$env:LOCALAPPDATA\Programs\nodejs;" + $env:Path }

$dataDir = if ($env:MTGDS_DATA_DIR) { $env:MTGDS_DATA_DIR } else { Join-Path $root 'data' }
$reports = Join-Path $dataDir 'reports'
New-Item -ItemType Directory -Force $reports | Out-Null

$tc = & npm run typecheck 2>&1
$typecheck = if ($LASTEXITCODE -eq 0) { 'ok' } else { 'failed' }

$out = & npm test 2>&1 | Out-String
$num = { param($name) if ($out -match "(?m)^\S*\s*$name (\d+)") { [int]$Matches[1] } else { 0 } }
$total = & $num 'tests'; $pass = & $num 'pass'; $fail = & $num 'fail'
if ($total -eq 0) { $fail = [Math]::Max($fail, 1) }  # Testlauf ist gar nicht gestartet → als Fehler werten

$ext = $null
if ($WithExtension) {
  $extOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'extension\test\run-test.ps1') 2>&1 | Out-String
  $ext = if ($LASTEXITCODE -eq 0) { 'ok' } else { 'failed' }
}

$summary = [ordered]@{ total = $total; passed = $pass; failed = $fail; typecheck = $typecheck; at = (Get-Date).ToUniversalTime().ToString('o'); extensionTests = $ext }
$testsFile = Join-Path $reports 'tests-latest.json'
$summary | ConvertTo-Json | Out-File -FilePath $testsFile -Encoding utf8

& npm run report --silent -- --tests $testsFile
$code = $LASTEXITCODE
Write-Host "Tests: $pass/$total bestanden, $fail fehlgeschlagen; Typprüfung: $typecheck"
exit $code
