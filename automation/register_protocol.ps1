# vacation-auto:// URL protocol handler 등록
# setup.bat에서 호출됨

$scriptDir = Split-Path -Parent $PSCommandPath
$runBat = Join-Path $scriptDir "run.bat"

if (-not (Test-Path $runBat)) {
    Write-Host "[ERROR] run.bat not found: $runBat" -ForegroundColor Red
    exit 1
}

$basePath = "HKCU:\Software\Classes\vacation-auto"
$cmdPath = "$basePath\shell\open\command"

try {
    # Base key
    if (-not (Test-Path $basePath)) {
        New-Item -Path $basePath -Force | Out-Null
    }
    Set-ItemProperty -Path $basePath -Name "(default)" -Value "URL:Vacation Auto Run"
    Set-ItemProperty -Path $basePath -Name "URL Protocol" -Value ""

    # Command key
    if (-not (Test-Path $cmdPath)) {
        New-Item -Path $cmdPath -Force | Out-Null
    }
    $cmdValue = "`"$runBat`" --auto `"%1`""
    Set-ItemProperty -Path $cmdPath -Name "(default)" -Value $cmdValue

    Write-Host "Protocol registered: vacation-auto://" -ForegroundColor Green
    Write-Host "  Handler: $runBat" -ForegroundColor Gray
    exit 0
} catch {
    Write-Host "[ERROR] Failed to register protocol: $_" -ForegroundColor Red
    exit 1
}
