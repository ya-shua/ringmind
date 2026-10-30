@echo off
title stop ringmind
echo.
echo   Stopping the memory panel on port 5173...
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
  if not errorlevel 1 set FOUND=1
)

if "%FOUND%"=="1" (
  echo   Stopped.
) else (
  echo   Not running.
)

echo.
ping -n 3 127.0.0.1 >nul 2>&1