@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\win-x64\node.exe" (
  echo Runtime Windows x64 ausente. Extraia completamente o ZIP.
  pause
  exit /b 1
)
if "%~1"=="" (
  "runtime\win-x64\node.exe" "scripts\start.mjs" --open
) else (
  "runtime\win-x64\node.exe" %*
)
if errorlevel 1 pause
