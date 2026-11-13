@echo off
REM Chay Eduspace Mini voi DU LIEU THAT (data\app.db) o cong 3000
cd /d "%~dp0.."
if not exist node_modules (
  echo Dang cai dat thu vien lan dau...
  call npm install --omit=dev
)
title Eduspace Mini - dang chay (KHONG DONG CUA SO NAY)
set NODE_ENV=production
set PORT=3000
node src\server.js
pause
