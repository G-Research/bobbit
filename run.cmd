@echo off
setlocal

rem 1. Resolve BOBBIT_HOME — directory containing this script
set "BOBBIT_HOME=%~dp0"
rem Remove trailing backslash
if "%BOBBIT_HOME:~-1%"=="\" set "BOBBIT_HOME=%BOBBIT_HOME:~0,-1%"

rem 2. Check node is available
where node >nul 2>nul
if errorlevel 1 (
    echo Error: Node.js is required but not found on PATH. >&2
    exit /b 1
)

rem 3. Auto-bootstrap if needed
if not exist "%BOBBIT_HOME%\node_modules" goto :bootstrap
if not exist "%BOBBIT_HOME%\dist\server\cli.js" goto :bootstrap
goto :launch

:bootstrap
echo First run — installing dependencies and building...
pushd "%BOBBIT_HOME%"
call npm install
if errorlevel 1 (
    echo Error: npm install failed. >&2
    popd
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo Error: npm run build failed. >&2
    popd
    exit /b 1
)
popd

:launch
rem 4. Launch with implicit --cwd as current directory, forwarding all args
node "%BOBBIT_HOME%\dist\server\cli.js" --cwd "%CD%" %*
