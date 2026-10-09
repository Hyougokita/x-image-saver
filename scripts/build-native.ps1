$ErrorActionPreference = 'Stop'
$taskPackageRoot = Split-Path -Parent $PSScriptRoot
$taskCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) { throw 'The Windows .NET Framework C# compiler was not found.' }
$taskSource = Join-Path $taskPackageRoot 'native\XImageSaverHost.cs'
$taskOutput = Join-Path $taskPackageRoot 'native\XImageSaverHost.exe'
& $taskCompiler /nologo /target:winexe /codepage:65001 "/out:$taskOutput" /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $taskSource
if ($LASTEXITCODE -ne 0) { throw 'Native helper compilation failed.' }
Write-Output 'Built native/XImageSaverHost.exe'
