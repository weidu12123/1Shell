@echo off
chcp 65001 >nul 2>&1
title 1Shell - One Shell to rule them all

echo.
echo  ╔════════════════════════════════════════════════╗
echo  ║         1Shell v3.3.0                          ║
echo  ║     One Shell to rule them all.                ║
echo  ╚════════════════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js 18 或更高版本
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 检查 Node.js 版本
for /f "tokens=1 delims=v" %%i in ('node -v') do set "NODE_VER=%%i"
for /f "tokens=1 delims=." %%i in ('node -v') do set "NODE_MAJOR=%%i"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
echo [1Shell] Node.js %NODE_MAJOR% 已检测到

:: 检查依赖是否安装
if not exist "node_modules\" (
    echo [1Shell] 首次运行，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo [1Shell] 依赖安装完成
)

:: 检查 .env 是否存在
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo [1Shell] 已从 .env.example 创建 .env 配置文件
        echo [1Shell] 请编辑 .env 设置登录密码和 API Key
        echo.
    )
)

:: 启动服务
echo [1Shell] 正在启动服务...
echo [1Shell] 启动后访问: http://localhost:3301
echo [1Shell] 默认账号: admin / admin（请在设置中修改）
echo [1Shell] 按 Ctrl+C 停止服务
echo.
node server.js
