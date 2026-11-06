@echo off
title Mobilise Diwali Utsav - voting server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules\nodemailer (echo Installing dependencies... & call npm install --no-audit --no-fund)
if "%ADMIN_PASSWORD%"=="" set /p ADMIN_PASSWORD=Choose an organiser password (press Enter for the default "diwali2026"):
node server.js
pause
