# SPDX-License-Identifier: AGPL-3.0-only
# Creates ignored transfer archives for cloud-init-local.yaml; never publishes.
param(
    [Parameter(Mandatory)]
    [string]$Image
)
$ErrorActionPreference = 'Stop'
$deployRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $deployRoot 'dist'
$localTag = 'plaingym:v0.0.0-local'
$buildTag = $Image
$actualArchitecture = docker image inspect $buildTag --format '{{.Architecture}}'
if ($LASTEXITCODE -ne 0 -or $actualArchitecture -notin @('amd64', 'arm64')) { throw 'Build and test the matching image first.' }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
docker tag $buildTag $localTag
if ($LASTEXITCODE -ne 0) { throw 'Image tag failed.' }
docker save $localTag -o (Join-Path $outputDirectory 'plaingym-image.tar')
if ($LASTEXITCODE -ne 0) { throw 'Image export failed.' }
# Explicit input list excludes environments, secrets, output, and test fixtures.
tar -cf (Join-Path $outputDirectory 'plaingym-deploy.tar') -C $deployRoot compose.yaml Caddyfile lib.sh install.sh update.sh postgres/01-roles.sh
if ($LASTEXITCODE -ne 0) { throw 'Bundle export failed.' }
Get-FileHash -Algorithm SHA256 (Join-Path $outputDirectory 'plaingym-image.tar'), (Join-Path $outputDirectory 'plaingym-deploy.tar') | Select-Object Path, Hash
