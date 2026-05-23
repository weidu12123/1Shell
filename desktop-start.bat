@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
title 1Shell Desktop

if exist "%~dp0node\npm.cmd" (
  set "NPM_CMD=%~dp0node\npm.cmd"
) else (
  set "NPM_CMD=npm"
)

"%NPM_CMD%" run desktop:dev
if errorlevel 1 pause
