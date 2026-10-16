@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 22.12+（含 npm）：https://nodejs.org/
  pause
  exit /b 1
)
node scripts/start.mjs %*
exit /b %errorlevel%
