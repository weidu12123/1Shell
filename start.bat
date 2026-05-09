@echo off
chcp 65001 >nul 2>&1
title 1Shell - One Shell to rule them all

echo.
echo  +================================================+
echo  ^|         1Shell v3.4.0                          ^|
echo  ^|     One Shell to rule them all.                ^|
echo  +================================================+
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Check Node.js version
for /f "tokens=1 delims=v" %%i in ('node -v') do set "NODE_VER=%%i"
for /f "tokens=1 delims=." %%i in ('node -v') do set "NODE_MAJOR=%%i"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
echo [1Shell] Node.js %NODE_MAJOR% detected

:: Check dependencies
if not exist "node_modules\" (
    echo [1Shell] First run - installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [1Shell] Dependencies installed
)

:: Check .env
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo [1Shell] Created .env from .env.example
        echo [1Shell] Please edit .env to set password and API Key
        echo.
    )
)

:: Start server
echo [1Shell] Starting server...
echo [1Shell] URL: http://localhost:3301
echo [1Shell] Default login: admin / admin
echo [1Shell] Press Ctrl+C to stop
echo.
node server.js
