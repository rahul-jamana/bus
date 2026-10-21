@echo off
title College ERP Local Server
echo ========================================================
echo   Starting BEC College ERP Local Gateway Server
echo ========================================================
cd /d "%~dp0\COLLEGE ERP\campus-portal"
node server.js
pause
