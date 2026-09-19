@echo off
rem Double-click launcher for Start-DSH.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-DSH.ps1" %*
