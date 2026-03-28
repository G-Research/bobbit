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
if not exist "%BOBBIT_HOME%\node_modules" (
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
)
if not exist "%BOBBIT_HOME%\dist\server\cli.js" (
    echo Building server...
    pushd "%BOBBIT_HOME%"
    call npm run build:server
    if errorlevel 1 (
        echo Error: build:server failed. >&2
        popd
        exit /b 1
    )
    popd
)
if not exist "%BOBBIT_HOME%\dist\ui\index.html" (
    echo Building UI...
    pushd "%BOBBIT_HOME%"
    call npm run build:ui
    if errorlevel 1 (
        echo Error: build:ui failed. >&2
        popd
        exit /b 1
    )
    popd
)

rem 3b. Rebuild if source is newer than build output
if exist "%BOBBIT_HOME%\dist\server\cli.js" (
    for /f %%R in ('powershell -NoProfile -Command "$ref = (Get-Item -LiteralPath '%BOBBIT_HOME%\dist\server\cli.js').LastWriteTime; $dirs = @('%BOBBIT_HOME%\src\server'); $files = @('%BOBBIT_HOME%\package.json','%BOBBIT_HOME%\tsconfig.server.json'); $stale = $false; foreach ($d in $dirs) { if (Get-ChildItem -LiteralPath $d -Recurse -File | Where-Object { $_.LastWriteTime -gt $ref } | Select-Object -First 1) { $stale = $true; break } }; if (-not $stale) { foreach ($f in $files) { if ((Get-Item -LiteralPath $f).LastWriteTime -gt $ref) { $stale = $true; break } } }; if ($stale) { Write-Output 'stale' } else { Write-Output 'fresh' }"') do (
        if "%%R"=="stale" (
            echo ⚡ Server source changed — rebuilding...
            pushd "%BOBBIT_HOME%"
            call npm run build:server
            if errorlevel 1 (
                echo Error: build:server failed. >&2
                popd
                exit /b 1
            )
            popd
        )
    )
)
if exist "%BOBBIT_HOME%\dist\ui\index.html" (
    for /f %%R in ('powershell -NoProfile -Command "$ref = (Get-Item -LiteralPath '%BOBBIT_HOME%\dist\ui\index.html').LastWriteTime; $dirs = @('%BOBBIT_HOME%\src\ui','%BOBBIT_HOME%\src\app'); $stale = $false; foreach ($d in $dirs) { if (Get-ChildItem -LiteralPath $d -Recurse -File | Where-Object { $_.LastWriteTime -gt $ref } | Select-Object -First 1) { $stale = $true; break } }; if ($stale) { Write-Output 'stale' } else { Write-Output 'fresh' }"') do (
        if "%%R"=="stale" (
            echo ⚡ UI source changed — rebuilding...
            pushd "%BOBBIT_HOME%"
            call npm run build:ui
            if errorlevel 1 (
                echo Error: build:ui failed. >&2
                popd
                exit /b 1
            )
            popd
        )
    )
)

:launch
rem 4. Launch with implicit --cwd as current directory, forwarding all args
node "%BOBBIT_HOME%\dist\server\cli.js" --cwd "%CD%" %*
