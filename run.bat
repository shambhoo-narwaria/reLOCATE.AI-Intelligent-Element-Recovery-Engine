@echo off
echo ==========================================================
echo           reLOCATE.AI - Automated Installer and Runner
echo ==========================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your PATH.
    echo Please install Node.js v18 or higher and try again.
    pause
    exit /b 1
)

echo [1/3] Installing dependencies and Playwright browser binaries...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/3] Building TypeScript files to production JavaScript...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b %errorlevel%
)

echo.
echo [3/3] Running the application...
call npm start

pause
