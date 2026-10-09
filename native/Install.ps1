param([switch]$ValidateOnly, [switch]$ValidateConverterOnly)

$ErrorActionPreference = 'Stop'
try {
    $taskPackageRoot = Split-Path -Parent $PSScriptRoot
    $taskManifest = Get-Content -LiteralPath (Join-Path $taskPackageRoot 'extension\manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $taskPublicKey = [Convert]::FromBase64String($taskManifest.key)
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try { $taskHash = $taskHasher.ComputeHash($taskPublicKey) } finally { $taskHasher.Dispose() }
    $taskExtensionId = -join ($taskHash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
    if ($ValidateOnly) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [ordered]@{
            valid = $true
            name = $taskManifest.name
            description = $taskManifest.description
            version = $taskManifest.version
            extensionId = $taskExtensionId
        } | ConvertTo-Json -Compress
        exit 0
    }
    $taskConverterSourceDirectory = Join-Path $PSScriptRoot 'ffmpeg'
    $taskConverterSourceExe = Join-Path $taskConverterSourceDirectory 'ffmpeg.exe'
    $taskConverterMetadata = Get-Content -LiteralPath (Join-Path $taskConverterSourceDirectory 'provenance.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $taskConverterHasher = [Security.Cryptography.SHA256]::Create()
    $taskConverterStream = [IO.File]::OpenRead($taskConverterSourceExe)
    try {
        $taskConverterHash = [BitConverter]::ToString($taskConverterHasher.ComputeHash($taskConverterStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $taskConverterStream.Dispose()
        $taskConverterHasher.Dispose()
    }
    if ($taskConverterHash -ne $taskConverterMetadata.binarySha256) {
        throw 'GIF 转码工具校验失败，请重新解压完整安装包。'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw '动图转 GIF 需要 64 位 Windows 10 / 11。'
    }
    if ($ValidateConverterOnly) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [ordered]@{ valid = $true; build = $taskConverterMetadata.build; binarySha256 = $taskConverterHash } | ConvertTo-Json -Compress
        exit 0
    }
    $taskInstallDirectory = Join-Path $env:LOCALAPPDATA 'XImageSaver'
    New-Item -ItemType Directory -Path $taskInstallDirectory -Force | Out-Null
    $taskExe = Join-Path $taskInstallDirectory 'XImageSaverHost.exe'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'XImageSaverHost.exe') -Destination $taskExe -Force
    $taskConverterInstallDirectory = Join-Path $taskInstallDirectory 'ffmpeg'
    New-Item -ItemType Directory -Path $taskConverterInstallDirectory -Force | Out-Null
    foreach ($taskConverterName in @('ffmpeg.exe', 'LICENSE', 'README.txt', 'provenance.json')) {
        Copy-Item -LiteralPath (Join-Path $taskConverterSourceDirectory $taskConverterName) -Destination (Join-Path $taskConverterInstallDirectory $taskConverterName) -Force
    }
    $taskNativeManifestPath = Join-Path $taskInstallDirectory 'com.local.x_image_saver.json'
    $taskNativeManifest = @{
        name = 'com.local.x_image_saver'
        description = 'X Image Saver local folder helper'
        path = $taskExe
        type = 'stdio'
        allowed_origins = @("chrome-extension://$taskExtensionId/")
    }
    $taskUtf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($taskNativeManifestPath, ($taskNativeManifest | ConvertTo-Json -Depth 4), $taskUtf8)
    $taskRegistry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Google\Chrome\NativeMessagingHosts\com.local.x_image_saver')
    try { $taskRegistry.SetValue('', $taskNativeManifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $taskRegistry.Dispose() }
    Write-Host ''
    Write-Host '本机助手安装完成！无需管理员权限。' -ForegroundColor Green
    Write-Host "安装位置：$taskInstallDirectory"
    Write-Host "扩展 ID：$taskExtensionId"
    Write-Host ''
    Write-Host '接下来：Chrome -> chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序'
    Write-Host "选择这个目录：$(Join-Path $taskPackageRoot 'extension')"
    Write-Host '点击扩展图标，添加保存目录并保存设置。'
    exit 0
} catch {
    Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
