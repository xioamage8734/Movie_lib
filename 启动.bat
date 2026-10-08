@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Movie Library
echo ============================================================
echo.
echo   dir: "%~dp0"
echo.

rem ---- locate node.exe (PATH may be stale for double-clicked bat) ----
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE goto NONODE

echo   node: "%NODE_EXE%"
chcp 65001 >nul
echo.
echo   starting server ...
echo   local :  http://localhost:7777
echo   keep this window open; close it to stop.
echo.

start "" /b cmd /c "timeout /t 2 >nul & explorer http://localhost:7777"

"%NODE_EXE%" "%~dp0src\server.js"

echo.
echo [server stopped]
pause
exit /b 0

:NONODE
echo [ERROR] node.exe was not found.
echo.
echo   - If Node.js is installed, close this window and try again,
echo     or restart your computer so the new PATH takes effect.
echo   - If not installed, get it from:  https://nodejs.org
echo     (choose the LTS version, keep clicking Next)
echo.
pause
exit /b 1
