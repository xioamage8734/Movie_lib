@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Step 2 : fetch douban metadata + download posters
echo  ~300 movies, roughly 20-25 minutes (1.5s per request)
echo  Safe to interrupt: finished items are cached and skipped.
echo ============================================================
echo.
node src\fetch.js %*
echo.
pause
