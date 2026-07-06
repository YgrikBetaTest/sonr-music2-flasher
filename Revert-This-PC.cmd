@echo off
setlocal enableextensions
title SONR Music 2 - revert PC setup

rem === self-elevate (UAC) ===
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)

echo(
echo   Reverting SONR Music 2 PC setup...
echo(

echo [1/3] Removing the WebUSB policy...
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v WebUsbAllowDevicesForUrls /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome" /v WebUsbAllowDevicesForUrls /f >nul 2>&1

echo [2/3] Removing the WinUSB driver package...
powershell -NoProfile -Command "$t=(pnputil /enum-drivers | Out-String); $n=0; foreach($m in [regex]::Matches($t,'Published Name:\s*(oem\d+\.inf)[\s\S]*?Original Name:\s*SONR_WinUSB\.inf')){ $p=$m.Groups[1].Value; Write-Host ('  deleting '+$p); pnputil /delete-driver $p /uninstall /force | Out-Null; $n++ }; if($n -eq 0){ Write-Host '  (no SONR_WinUSB driver package found)' }"

echo [3/3] Removing the trusted certificate...
certutil -delstore Root "SONR Music 2 WinUSB (self-signed)" >nul 2>&1
certutil -delstore TrustedPublisher "SONR Music 2 WinUSB (self-signed)" >nul 2>&1

echo(
echo   Done. Unplug and replug the device so Windows re-detects it.
echo   (Windows may reinstall the WCH CH375 driver if it is present.)
echo(
pause
exit /b 0
