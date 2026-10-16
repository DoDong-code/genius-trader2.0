@echo off
REM Nav gap audit - READ ONLY (no backfill, no --apply)
REM Usage: double-click this file. It runs auditNavGaps only.
REM NOTE: the script calls ensureCloudSchema() first (CREATE TABLE IF NOT EXISTS, idempotent).
setlocal
cd /d "%~dp0.."
echo [nav-audit] Starting READ-ONLY gap audit (window=365)...
echo [nav-audit] Do NOT add --apply unless you want to WRITE to the database.
echo.
node scripts\nav-backfill.js --window=365
echo.
echo [nav-audit] Finished. Scroll up to review the gap report.
pause
