@echo off
cd /d "%~dp0"
echo ============================================================
echo   Movie Library  -  auto fetch douban data (long running)
echo.
echo   * keeps retrying until every movie is fetched
echo   * backs off automatically when douban rate-limits
echo   * progress is saved continuously; safe to close anytime
echo   * press Ctrl+C to stop
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 goto NONODE
chcp 65001 >nul
node "%~dp0src\fetch.js" --forever
echo.
echo [stopped]
pause
exit /b 0

:NONODE
echo [ERROR] "node" was not found in PATH.
echo Open a cmd window and run:   node -v
echo If that also fails, Node.js is not installed/available for your user.
echo.
pause
exit /b 1
