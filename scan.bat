@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Movie library - Step 1 : scan and parse file names
echo  dirs: G:/movie1  J:/movie2  M:/movie3
echo ============================================================
echo.
node src\scan.js
if errorlevel 1 goto :err
echo.
echo ---- data\preview.txt (first 14 lines, just generated) ----
node -e "const fs=require('fs');const t=fs.readFileSync('data/preview.txt','utf8').split(/\r?\n/).slice(0,14);for(const l of t)console.log(l);"
echo.
echo Full result file: data\preview.txt
echo.
pause
exit /b 0

:err
echo.
echo [ERROR] scan failed. Is Node.js installed?  Check with:  node -v
echo.
pause
exit /b 1
