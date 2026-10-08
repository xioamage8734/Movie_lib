@echo off
cd /d "%~dp0"
echo ============================================================
echo   Movie Library  -  first-time setup
echo   (you will be asked where your movies are)
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 goto NONODE
chcp 65001 >nul
node "%~dp0src\setup.js"
echo.
pause
exit /b 0

:NONODE
echo [ERROR] "node" was not found in PATH.
echo Please install Node.js first:  https://nodejs.org
echo After installing, open a NEW cmd window and run:  node -v
echo.
pause
exit /b 1
