@echo off
rem Speed run: measures every installed local model, as Settings, Local models, Benchmark all
rem does, with KzH closed. Double-click it, or run it from Task Scheduler.
rem   Speed-Run.bat                          every installed local chat model
rem   Speed-Run.bat --models qwen3-8b        only the models named, comma separated
rem   Speed-Run.bat --context 24576          the context KzH starts local models with, when
rem                                          the profile sets one this cannot read
rem   Speed-Run.bat --no-pause               no key press at the end (Task Scheduler)
rem   Speed-Run.bat --verbose                the engine log as it runs
rem   Speed-Run.bat --accept-output          accept the new output a run kept aside, for the
rem                                          models named with --models or every one waiting;
rem                                          it measures nothing
rem Readings go to local.json, where KzH reads them at its next start. Every run is logged in
rem %USERPROFILE%\.kzh\jev-router\speed-runs: speed-runs.log, one entry per run, and a detail
rem log per run beside it (see scripts\speed-run.mjs).
rem Ctrl+C cancels; cmd then asks "Terminate batch job (Y/N)?": answer N to keep the window
rem open on the results.
rem Exit codes: 0 all measured, 1 a model not measured, 2 could not run, 3 KzH or another
rem speed run is running, 4 all measured but a model's output differs from its baseline (its
rem figure is kept aside until accepted), 130 cancelled with Ctrl+C. --accept-output exits 0
rem when every output asked for is accepted (or none was waiting), 2 when a model named has
rem none waiting, 3 as a run does.
setlocal
set pause=1
for %%a in (%*) do if /i "%%~a"=="--no-pause" set pause=0
where node >nul 2>nul || (echo Node.js is not on PATH. Install Node.js 22.19 or newer from https://nodejs.org and run this again.& set code=2& goto done)
node "%~dp0scripts\speed-run.mjs" %*
set code=%errorlevel%
:done
if "%pause%"=="1" pause
exit /b %code%
