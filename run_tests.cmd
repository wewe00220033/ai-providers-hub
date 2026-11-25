@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

chcp 65001 >nul 2>&1
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=unit"

echo ========================================================
echo  AI Providers Puzzle Hub - Test Runner [%MODE%]
echo ========================================================

set "PY_RC=0"
set "NODE_RC=0"
set "SMOKE_RC=0"

if exist "tests\python" (
    echo [1/2] Running Python stdlib unittest suite...
    python -m unittest discover -s tests/python -p "test_*.py" -v
    set "PY_RC=!errorlevel!"
    if not "!PY_RC!"=="0" (
        echo [FAIL] Python unit tests failed with code !PY_RC!
        exit /b !PY_RC!
    )
) else (
    echo [FAIL] Missing tests\python directory!
    exit /b 1
)

dir /b tests\node\*.test.js >nul 2>&1
if "!errorlevel!"=="0" (
    echo [2/2] Running Node built-in test runner...
    node --test tests/node/*.test.js
    set "NODE_RC=!errorlevel!"
    if not "!NODE_RC!"=="0" (
        echo [FAIL] Node unit tests failed with code !NODE_RC!
        exit /b !NODE_RC!
    )
) else (
    echo [INFO] No Node tests found in tests\node\ yet - skipped in pre-D2 stage.
)

if /i "%MODE%"=="unit" (
    echo [PASS] Unit tests passed cleanly.
    exit /b 0
)

if /i "%MODE%"=="all" (
    if not defined HUB_URL goto :skip_live
    if not defined HUB_TEST_TOKEN goto :skip_live
    if not exist "tests\smoke\live_smoke.py" (
        echo [FAIL] HUB_URL set but tests\smoke\live_smoke.py missing!
        exit /b 1
    )
    echo [3/3] Running live Apps Script smoke suite...
    python tests/smoke/live_smoke.py
    set "SMOKE_RC=!errorlevel!"
    if not "!SMOKE_RC!"=="0" (
        echo [FAIL] Live smoke suite failed with code !SMOKE_RC!
        exit /b !SMOKE_RC!
    )
    echo [PASS] Unit + Live smoke tests passed.
    exit /b 0
)

echo [ERROR] Unknown mode "%MODE%". Expected: unit or all.
exit /b 2

:skip_live
echo [INFO] SKIPPED LIVE SMOKE: HUB_URL or HUB_TEST_TOKEN not set.
echo [PASS] All local unit tests passed cleanly.
exit /b 0
