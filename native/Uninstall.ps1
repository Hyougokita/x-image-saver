$ErrorActionPreference = 'Stop'
try {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\Google\Chrome\NativeMessagingHosts\com.local.x_image_saver', $false)
    $taskInstallDirectory = Join-Path $env:LOCALAPPDATA 'XImageSaver'
    foreach ($taskName in @('XImageSaverHost.exe', 'com.local.x_image_saver.json')) {
        $taskTarget = Join-Path $taskInstallDirectory $taskName
        if (Test-Path -LiteralPath $taskTarget) { Remove-Item -LiteralPath $taskTarget -Force }
    }
    $taskConverterDirectory = Join-Path $taskInstallDirectory 'ffmpeg'
    foreach ($taskConverterName in @('ffmpeg.exe', 'LICENSE', 'README.txt', 'provenance.json')) {
        $taskConverterTarget = Join-Path $taskConverterDirectory $taskConverterName
        if (Test-Path -LiteralPath $taskConverterTarget) { Remove-Item -LiteralPath $taskConverterTarget -Force }
    }
    if ((Test-Path -LiteralPath $taskConverterDirectory) -and -not (Get-ChildItem -LiteralPath $taskConverterDirectory -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $taskConverterDirectory
    }
    Write-Host '本机助手已卸载，目录配置保留在原位置。' -ForegroundColor Green
    Write-Host '请在 Chrome 的扩展管理页移除“媒体存档”（旧版名为“图片存档”）。'
    exit 0
} catch {
    Write-Host "卸载失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '请关闭正在选择文件夹的窗口，等待保存结束后重试。'
    exit 1
}
