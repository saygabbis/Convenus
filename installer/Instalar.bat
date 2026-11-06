@echo off
chcp 65001 >nul
title Convenus — instalador
cd /d "%~dp0"
echo.
echo  Convenus Sync — instalacao sem administrador
echo  Nao fecha o Chrome normal; cria um perfil separado.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Convenus.ps1"
echo.
pause
