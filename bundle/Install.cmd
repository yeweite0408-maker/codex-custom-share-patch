@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0Install.ps1" %*
set "CODEX_CUSTOM_INSTALL_EXIT=%ERRORLEVEL%"
if not "%CODEX_CUSTOM_INSTALL_EXIT%"=="0" echo Installation did not complete. Read the error above.
pause
exit /b %CODEX_CUSTOM_INSTALL_EXIT%
