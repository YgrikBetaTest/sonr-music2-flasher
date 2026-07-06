@echo off
setlocal enableextensions
title SONR Music 2 - one-time PC setup

rem === self-elevate (UAC) ===
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)

set "ROOT=%~dp0"
set "DRV=%ROOT%driver-setup"

echo(
echo   SONR Music 2 - one-time setup for this PC
echo   =========================================
echo   (installs the WinUSB driver + browser access, no Zadig needed)
echo(

echo [1/3] Trusting the driver certificate...
certutil -addstore -f Root "%DRV%\SONR_WinUSB.cer" >nul
if errorlevel 1 goto :fail
certutil -addstore -f TrustedPublisher "%DRV%\SONR_WinUSB.cer" >nul
if errorlevel 1 goto :fail

echo [2/3] Installing the WinUSB driver for the SONR bootloader...
pnputil /add-driver "%DRV%\SONR_WinUSB.inf" /install
set "PN=%errorlevel%"
if "%PN%"=="0" goto :drvok
if "%PN%"=="3010" goto :drvok
echo   Note: pnputil returned %PN% - the driver is staged and will bind when the
echo   device is next plugged in holding "+". Continuing.
:drvok

echo [3/3] Enabling browser access (WebUSB policy)...
reg import "%ROOT%enable-webusb-auto.reg"
if errorlevel 1 goto :fail

echo(
echo   SUCCESS.
echo   1) Close and reopen your browser (Edge or Chrome).
echo   2) Plug the device in while holding "+"  -  no driver pop-ups.
echo   3) Open the flasher page and press Update.
echo(
pause
exit /b 0

:fail
echo(
echo   SETUP FAILED - see the message above. Try running again as administrator.
echo(
pause
exit /b 1
