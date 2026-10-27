@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm was not found.
  echo Install Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Petal Bloom...
echo Keep this window open while using the page.
echo Address: http://127.0.0.1:4173/
echo.
echo Press Ctrl+C to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 2500; Start-Process 'http://127.0.0.1:4173/'"
call npm run dev -- --strictPort
echo.
echo Server stopped. Press any key to close.
pause >nul
endlocal
