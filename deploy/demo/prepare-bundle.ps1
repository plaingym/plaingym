# SPDX-License-Identifier: AGPL-3.0-only
# Maintainer-side only; all server inputs are runtime prompts, never bundle files.
param(
    [Parameter(Mandatory)] [string]$Image,
    [ValidateSet('amd64', 'arm64')] [string]$Architecture = 'amd64',
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$')]
    [string]$AppTag = 'plaingym:v0.0.0-local'
)
$ErrorActionPreference = 'Stop'
$deployRoot = Split-Path -Parent $PSScriptRoot
$bundleOutput = Join-Path $PSScriptRoot 'dist'
$staging = Join-Path $bundleOutput 'staging'
$appArchitecture = docker image inspect $Image --format '{{.Architecture}}'
if ($LASTEXITCODE -ne 0 -or $appArchitecture -ne $Architecture) { throw 'Build and test the matching app image first.' }
$caddyImage = 'plaingym-caddy:v2.11.7-cf0.2.4'
docker build --platform "linux/$Architecture" -t $caddyImage -f (Join-Path $PSScriptRoot 'Dockerfile') $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Prebuilt Caddy image failed.' }
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'deploy/demo/images'), (Join-Path $staging 'deploy/postgres') | Out-Null
foreach ($file in @('compose.yaml', 'lib.sh', 'host.sh', 'install.sh')) { Copy-Item -LiteralPath (Join-Path $deployRoot $file) -Destination (Join-Path $staging "deploy/$file") }
Copy-Item -LiteralPath (Join-Path $deployRoot 'postgres/01-roles.sh') -Destination (Join-Path $staging 'deploy/postgres/01-roles.sh')
foreach ($file in @('install.sh', 'host.sh', 'lib.sh', 'update.sh', 'snapshots.py', 'bootstrap.sh', 'config.py', 'compose.yaml', 'Caddyfile', 'Caddyfile.local.conf', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $staging "deploy/demo/$file")
}
docker tag $Image $AppTag
if ($LASTEXITCODE -ne 0) { throw 'App bundle tag failed.' }
docker save $AppTag -o (Join-Path $staging 'deploy/demo/images/app.tar')
if ($LASTEXITCODE -ne 0) { throw 'App bundle export failed.' }
docker save $caddyImage -o (Join-Path $staging 'deploy/demo/images/caddy.tar')
if ($LASTEXITCODE -ne 0) { throw 'Caddy export failed.' }
[IO.File]::WriteAllText((Join-Path $staging 'deploy/demo/images.env'), "# SPDX-License-Identifier: AGPL-3.0-only`nAPP_IMAGE=$AppTag`nCADDY_IMAGE=$caddyImage`nBUNDLE_ARCHITECTURE=$Architecture`n", [Text.UTF8Encoding]::new($false))
$archivePath = Join-Path $bundleOutput "plaingym-demo-$Architecture.tar"
# Explicit members exclude credentials, local test fixtures and stale staging files.
tar -cf $archivePath -C $staging deploy/compose.yaml deploy/lib.sh deploy/host.sh deploy/install.sh deploy/postgres/01-roles.sh deploy/demo/install.sh deploy/demo/host.sh deploy/demo/lib.sh deploy/demo/update.sh deploy/demo/snapshots.py deploy/demo/bootstrap.sh deploy/demo/config.py deploy/demo/compose.yaml deploy/demo/Caddyfile deploy/demo/Caddyfile.local.conf deploy/demo/README.md deploy/demo/images.env deploy/demo/images/app.tar deploy/demo/images/caddy.tar
if ($LASTEXITCODE -ne 0) { throw 'Demo bundle export failed.' }
$checksum = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
Write-Output "Bundle: $archivePath"
Write-Output "SHA256: $checksum"
Write-Output 'Upload the bundle and bootstrap.sh to the existing R2 bucket and presign them using the README commands.'
Write-Output 'Replace the quoted URL placeholders with those presigned URLs; keep the printed checksum:'
$bootstrapCommand = "curl --fail --silent --show-error --location --proto '=https' 'BOOTSTRAP_URL' | sudo sh -s -- --bundle-url 'BUNDLE_URL' --sha256 $checksum"
Write-Output $bootstrapCommand
Write-Output "For an app update: $bootstrapCommand --update $AppTag"
