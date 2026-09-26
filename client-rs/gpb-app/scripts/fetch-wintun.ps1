# Downloads wintun.dll (amd64) into src-tauri/wintun/, where the Windows bundle picks it up.
# Idempotent: does nothing when the DLL is already there.

$ErrorActionPreference = 'Stop'

$Version = '0.14.1'
$Sha256  = '07C256185D6EE3652E09FA55C0B673E2624B565E02C4B9091C79CA7D2F24EF51'

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'src-tauri\wintun'
$Dll  = Join-Path $Dest 'wintun.dll'

if (Test-Path $Dll) { exit 0 }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Zip = Join-Path $env:TEMP "wintun-$Version.zip"

Write-Host "==> Downloading Wintun $Version"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://www.wintun.net/builds/wintun-$Version.zip" -OutFile $Zip

$Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash
if ($Actual -ne $Sha256) {
    Remove-Item $Zip -Force
    throw "wintun-$Version.zip checksum mismatch: got $Actual"
}

$Tmp = Join-Path $env:TEMP "wintun-$Version"
if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $Tmp
Copy-Item (Join-Path $Tmp 'wintun\bin\amd64\wintun.dll') $Dll
Remove-Item $Zip, $Tmp -Recurse -Force

Write-Host "==> $Dll"
