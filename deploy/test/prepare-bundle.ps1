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
$imageDetails = docker image inspect $Image | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Inspect the image before creating a bundle.' }
$buildVersion = $imageDetails[0].Config.Labels.'org.opencontainers.image.version'
if ($buildVersion -notmatch '^v?\d+\.\d+\.\d+(\+[A-Za-z0-9.-]+)?$') { throw 'The image has no build version.' }
$localTag = 'plaingym:' + $buildVersion.Replace('+', '-')
$architecture = docker image inspect $Image --format '{{.Architecture}}'
if ($LASTEXITCODE -ne 0 -or $architecture -notin @('amd64', 'arm64')) { throw 'Build and test the matching image first.' }
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'deploy/postgres'), (Join-Path $staging 'deploy/images'), (Join-Path $staging 'deploy/systemd') | Out-Null
docker tag $Image $localTag
if ($LASTEXITCODE -ne 0) { throw 'Image tag failed.' }
docker save $localTag -o (Join-Path $staging 'deploy/images/app.tar')
if ($LASTEXITCODE -ne 0) { throw 'Image export failed.' }
# Explicit inputs exclude environments, secrets, output, and test fixtures.
foreach ($file in @('compose.yaml', 'Caddyfile', 'lib.sh', 'host.sh', 'install.sh', 'update.sh', 'rotate-key.sh', 'bootstrap.sh', 'cloudflare-ranges.txt', 'postgres/01-roles.sh', 'systemd/plaingym-update.service', 'systemd/plaingym-update.timer')) {
    Copy-Item -LiteralPath (Join-Path $deployRoot $file) -Destination (Join-Path $staging "deploy/$file")
}
# The release signing key, once the repository has one, lets update.sh --patch check releases.
$optional = @()
if (Test-Path -LiteralPath (Join-Path $deployRoot 'release-signing.pem')) {
    Copy-Item -LiteralPath (Join-Path $deployRoot 'release-signing.pem') -Destination (Join-Path $staging 'deploy/release-signing.pem')
    $optional += 'deploy/release-signing.pem'
}
[IO.File]::WriteAllText((Join-Path $staging 'deploy/images.env'), "# SPDX-License-Identifier: AGPL-3.0-only`nAPP_IMAGE=$localTag`nBUNDLE_ARCHITECTURE=$architecture`n", [Text.UTF8Encoding]::new($false))
$archivePath = Join-Path $outputDirectory "plaingym-$architecture.tar"
tar -cf $archivePath -C $staging deploy/compose.yaml deploy/Caddyfile deploy/lib.sh deploy/host.sh deploy/install.sh deploy/update.sh deploy/rotate-key.sh deploy/bootstrap.sh deploy/cloudflare-ranges.txt deploy/postgres/01-roles.sh deploy/systemd/plaingym-update.service deploy/systemd/plaingym-update.timer deploy/images.env deploy/images/app.tar @optional
if ($LASTEXITCODE -ne 0) { throw 'Bundle export failed.' }
Remove-Item -Recurse -Force $staging
$checksum = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
Write-Output "Bundle: $archivePath"
Write-Output "SHA256: $checksum"
Write-Output 'Upload the bundle and deploy/bootstrap.sh to private HTTPS storage (for example presigned R2 URLs; see deploy/README.md), then run on the server:'
Write-Output "curl --fail --silent --show-error --location --proto '=https' 'BOOTSTRAP_URL' | sudo sh -s -- --bundle-url 'BUNDLE_URL' --sha256 $checksum -- --hostname HOSTNAME --email EMAIL"
