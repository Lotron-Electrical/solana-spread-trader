@echo off
:: Solana Spread Trader — Borderless Window Launcher
:: Opens in Chrome app mode (no tabs, no address bar, no browser UI)

set "APP_PATH=%~dp0index.html"
set "CHROME="

:: Find Chrome
for %%p in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%p set "CHROME=%%~p"
)

if "%CHROME%"=="" (
  echo Chrome not found. Opening in default browser instead.
  start "" "%APP_PATH%"
  exit /b
)

:: Launch in app mode — borderless window, no browser UI
start "" "%CHROME%" --app="file:///%APP_PATH:\=/%#cinema" --window-size=1400,800 --window-position=80,40
