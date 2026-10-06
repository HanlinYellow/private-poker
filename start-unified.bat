@echo off
cd /d "%~dp0"
echo =========================================
echo Private Poker - Unified Deployment Build
echo =========================================
echo.
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
echo Building all frontends...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Starting unified server...
echo Local URL: http://localhost:3100
echo Radmin/Tailscale: http://YOUR-IP:3100
echo.
call npm start
pause
