@echo off
rem MTG Deal Sniper 2.2 - Start per Doppelklick (Windows)
cd /d "%~dp0"
where node >nul 2>nul || set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul || (
  echo Node.js wurde nicht gefunden. Bitte Node.js 24 LTS installieren: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installiere Abhaengigkeiten ...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
rem Bei jedem Start bauen, damit nach einem Update nie eine alte Oberflaeche ausgeliefert wird.
echo Baue das Dashboard ...
call npm run build || (pause & exit /b 1)
start "" http://localhost:8787
call npm start
pause
