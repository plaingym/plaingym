# SPDX-License-Identifier: AGPL-3.0-only
# Creates an ignored, checksummed deployment bundle for bootstrap.sh; never publishes.
param(
    [Parameter(Mandatory)]
    [string]$Image
)
$ErrorActionPreference = 'Stop'
$deployRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $deployRoot 'dist'
$staging = Join-Path $outputDirectory 'staging'
$localTag = 'plaingym:v0.0.0-local'
$architecture = docker image inspect $Image --format '{{.Architecture}}'
if ($LASTEXITCODE -ne 0 -or $architecture -notin @('amd64', 'arm64')) { throw 'Build and test the matching image first.' }
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'deploy/postgres'), (Join-Path $staging 'deploy/images') | Out-Null
docker tag $Image $localTag
if ($LASTEXITCODE -ne 0) { throw 'Image tag failed.' }
docker save $localTag -o (Join-Path $staging 'deploy/images/app.tar')
if ($LASTEXITCODE -ne 0) { throw 'Image export failed.' }
# Explicit inputs exclude environments, secrets, output, and test fixtures.
foreach ($file in @('compose.yaml', 'Caddyfile', 'lib.sh', 'host.sh', 'install.sh', 'update.sh', 'bootstrap.sh', 'postgres/01-roles.sh')) {
    Copy-Item -LiteralPath (Join-Path $deployRoot $file) -Destination (Join-Path $staging "deploy/$file")
}
[IO.File]::WriteAllText((Join-Path $staging 'deploy/images.env'), "# SPDX-License-Identifier: AGPL-3.0-only`nAPP_IMAGE=$localTag`nBUNDLE_ARCHITECTURE=$architecture`n", [Text.UTF8Encoding]::new($false))
$archivePath = Join-Path $outputDirectory "plaingym-$architecture.tar"
tar -cf $archivePath -C $staging deploy/compose.yaml deploy/Caddyfile deploy/lib.sh deploy/host.sh deploy/install.sh deploy/update.sh deploy/bootstrap.sh deploy/postgres/01-roles.sh deploy/images.env deploy/images/app.tar
if ($LASTEXITCODE -ne 0) { throw 'Bundle export failed.' }
Remove-Item -Recurse -Force $staging
$checksum = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
Write-Output "Bundle: $archivePath"
Write-Output "SHA256: $checksum"
Write-Output 'Upload the bundle and deploy/bootstrap.sh to private HTTPS storage (for example presigned R2 URLs; see deploy/README.md), then run on the server:'
Write-Output "curl --fail --silent --show-error --location --proto '=https' 'BOOTSTRAP_URL' | sudo sh -s -- --bundle-url 'BUNDLE_URL' --sha256 $checksum -- --hostname HOSTNAME --email EMAIL"
