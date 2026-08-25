<#
.SYNOPSIS
  build-push.ps1 — Windows-native port of build-push.sh. Builds, tags, and
  pushes the four DT-WATCH v2 images to Nexus.

.DESCRIPTION
  Line-for-line behavioral port of build-push.sh (same positional args, same
  branch-derived version suffix, same immutable tag format, same registry
  cache, same parallel builds, same env-var switches) — written so this can
  run directly from Windows PowerShell without WSL or Git Bash. The .sh
  script is bash-only (arrays, [[ ]], trap-free `set -euo pipefail`) and
  isn't something PowerShell can just dot-source, hence a real port rather
  than a thin wrapper.

  Known, deliberate differences from the bash version:
    - Architecture detection for the cross-build check uses
      `docker version --format '{{.Server.Arch}}'` (amd64/arm64) instead of
      `uname -m` (x86_64/aarch64) — Windows has no `uname`; Docker's own
      reported server arch is the more direct signal anyway.
    - Nepal-time formatting uses .NET's "Nepal Standard Time" Windows time
      zone ID via [System.TimeZoneInfo], not `TZ=Asia/Kathmandu date`.
    - Parallel builds use one docker.exe process per component
      (Start-Process, waited on after all four are launched) instead of
      bash job control (`&` + `wait`) — same "start all four, wait, then
      report" shape, different mechanism.

.EXAMPLE
  Interactive mode (prompts for version, suggesting latest tag + bump):
    .\build-push.ps1

.EXAMPLE
  Direct version mode (no prompt):
    .\build-push.ps1 v1.0.0

.EXAMPLE
  Custom registry and namespace:
    .\build-push.ps1 v1.0.0 nexus.ntc.net.np dtwatch

.EXAMPLE
  One component only (skips the other three):
    $env:ONLY = "frontend"; .\build-push.ps1 v1.0.0

.NOTES
  Positional arguments (all optional):
    [1] Version      - vX.Y.Z (interactive prompt when omitted)
    [2] Registry     - Nexus Docker registry (default: nexus.ntc.net.np)
    [3] ProjectName  - Project namespace (default: dtwatch)
    [4] BumpType     - major, minor, or bugfix (default: bugfix) — only used
                        to compute the suggested version in interactive mode

  Branch convention: the current git branch decides the version suffix.
    - `main`           -> clean release version (e.g. v1.2.0), tagged `latest`
    - any other branch -> `-dev` is enforced (e.g. v1.2.0-dev), never `latest`
    Enforced regardless of whether Version came from the prompt or an arg.

  Builds and pushes FOUR components. Directory -> image name:
    backend-django/  -> $Registry/$ProjectName/django
    backend-node/    -> $Registry/$ProjectName/node-gateway
    backend-go/      -> $Registry/$ProjectName/go-worker
    frontend-react/  -> $Registry/$ProjectName/frontend

  Tags pushed to Nexus:
    - Versioned:  <image>:$Version
    - Immutable:  <image>:$Version-$BuildNo-$NptTime-$GitSha (identical
                  across all four — one build, one correlatable tag)
    - Latest:     <image>:latest (skipped for prerelease versions, and when
                  $env:NO_LATEST = "1")

  Environment variables (same names as the bash version, still read via
  $env:, not PowerShell parameters — this keeps `ONLY=frontend .\build-
  push.ps1 v1.0.0`-style one-liners working the same way as the bash
  version's env-var switches):
    PLATFORMS      target platform(s), default linux/amd64
    ONLY           build one component (django|node-gateway|go-worker|frontend)
    NO_LATEST=1    never tag `latest`
    NEXUS_USER / NEXUS_PASSWORD   non-interactive docker login
    SKIP_LOGIN=1 / SKIP_GIT_TAG=1 / FORCE_GIT_TAG=1 / PUSH_GIT_TAG=y|n
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Version,
    [Parameter(Position = 1)][string]$Registry,
    [Parameter(Position = 2)][string]$ProjectName,
    [Parameter(Position = 3)][string]$BumpType = 'bugfix'
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Exit-WithError {
    param([string]$Message)
    Write-Host "Error: $Message" -ForegroundColor Red
    exit 1
}

# Registry credentials only — never blanket-load the whole .env into the
# process environment. This stack's .env holds SECRET_KEY and the Postgres
# password; reading only the two keys actually needed keeps them out of
# every child `docker buildx build`'s environment. Mirrors build-push.sh's
# own comment on this exact point.
function Get-EnvFileValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Key=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    $value = $line -replace "^\s*$Key=", ''
    $value = $value.Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrEmpty($value)) { return $null }
    return $value
}

foreach ($envFile in @('.env.prod', '.env')) {
    foreach ($key in @('NEXUS_USER', 'NEXUS_PASSWORD')) {
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key))) {
            $value = Get-EnvFileValue -Path $envFile -Key $key
            if ($value) { [Environment]::SetEnvironmentVariable($key, $value) }
        }
    }
}

$DefaultVersion = 'v0.0.0'
$DefaultRegistry = 'nexus.ntc.net.np'
$DefaultProjectName = 'dtwatch'
$DefaultPlatforms = 'linux/amd64'

if ([string]::IsNullOrEmpty($Registry)) { $Registry = $DefaultRegistry }
if ([string]::IsNullOrEmpty($ProjectName)) { $ProjectName = $DefaultProjectName }
$Platforms = $env:PLATFORMS
if ([string]::IsNullOrEmpty($Platforms)) { $Platforms = $DefaultPlatforms }

# dir:image pairs — the two differ for every component here (backend-django
# -> django, frontend-react -> frontend), kept explicit rather than derived.
$Components = @(
    [PSCustomObject]@{ Dir = 'backend-django'; Name = 'django' }
    [PSCustomObject]@{ Dir = 'backend-node';   Name = 'node-gateway' }
    [PSCustomObject]@{ Dir = 'backend-go';     Name = 'go-worker' }
    [PSCustomObject]@{ Dir = 'frontend-react'; Name = 'frontend' }
)

if (-not [string]::IsNullOrEmpty($env:ONLY)) {
    $filtered = $Components | Where-Object { $_.Name -eq $env:ONLY }
    if (-not $filtered) {
        Exit-WithError "ONLY='$($env:ONLY)' matches no component. Valid: django node-gateway go-worker frontend"
    }
    $Components = @($filtered)
}

$CurrentBranch = (& git rev-parse --abbrev-ref HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($CurrentBranch)) { $CurrentBranch = '' }
if ($CurrentBranch -eq 'main') {
    $BranchSuffix = ''
} else {
    $BranchSuffix = '-dev'
}

function Read-WithDefault {
    param([string]$PromptText, [string]$DefaultValue)
    $inputValue = Read-Host "$PromptText [$DefaultValue]"
    if ([string]::IsNullOrEmpty($inputValue)) { return $DefaultValue }
    return $inputValue
}

# Interactive mode if no version given
if ([string]::IsNullOrEmpty($Version)) {
    $LatestTag = (& git tag --list 'v*' --sort=-v:refname 2>$null | Select-Object -First 1)
    if ([string]::IsNullOrEmpty($LatestTag)) { $LatestTag = $DefaultVersion }
    Write-Host "Latest version: $LatestTag"
    $branchNote = if ($BranchSuffix) { " (will suffix $BranchSuffix)" } else { '' }
    $branchLabel = if ($CurrentBranch) { $CurrentBranch } else { 'unknown' }
    Write-Host "Building from branch: $branchLabel$branchNote"

    $Major = 1; $Minor = 0; $Patch = 0
    if ($LatestTag -match '^v?(\d+)\.(\d+)\.(\d+)') {
        $Major = [int]$Matches[1]
        $Minor = [int]$Matches[2]
        $Patch = [int]$Matches[3]
    }

    switch ($BumpType) {
        'major' { $SuggestedVer = "v$($Major + 1).0.0" }
        'minor' { $SuggestedVer = "v$Major.$($Minor + 1).0" }
        default { $SuggestedVer = "v$Major.$Minor.$($Patch + 1)" }
    }
    $SuggestedVer = "$SuggestedVer$BranchSuffix"

    $Version = Read-WithDefault -PromptText 'Enter image version' -DefaultValue $SuggestedVer
}

# Enforce the branch's version convention however Version arrived.
if ($CurrentBranch -eq 'main' -and $Version -like '*-dev') {
    Exit-WithError "refusing to build a '-dev' version ($Version) from main. main only produces release images."
} elseif ($CurrentBranch -ne 'main' -and $Version -notlike '*-dev') {
    $Version = "$Version-dev"
    $branchLabel = if ($CurrentBranch) { $CurrentBranch } else { 'unknown' }
    Write-Host "Non-main branch ($branchLabel) — appending -dev: $Version"
}

if ($Version -notmatch '^(v|release\.)?[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[A-Za-z0-9.]+)?$') {
    Exit-WithError 'VERSION must look like v1.0.0, v1.0.0.1, or v1.0.1-rc1'
}

# Git-tag real releases only (main). Dev builds stay fully traceable through
# the immutable image tag, which embeds the commit sha — tagging every dev
# build would just clutter `git tag --list`. FORCE_GIT_TAG=1 overrides.
if ($CurrentBranch -ne 'main' -and $env:FORCE_GIT_TAG -ne '1') {
    $branchLabel = if ($CurrentBranch) { $CurrentBranch } else { 'unknown' }
    Write-Host "Skipping git tag: non-release branch ($branchLabel). Set `$env:FORCE_GIT_TAG = '1' to override."
} else {
    $existingTags = (& git tag --list 2>$null)
    if (-not ($existingTags -contains $Version)) {
        if ($env:SKIP_GIT_TAG -ne '1') {
            git tag $Version
            if ($LASTEXITCODE -ne 0) { Exit-WithError "could not create git tag $Version" }
            $pushTag = $env:PUSH_GIT_TAG
            if ([string]::IsNullOrEmpty($pushTag) -and -not [Console]::IsInputRedirected) {
                $pushTag = Read-Host "Push git tag $Version to origin now? (y/N)"
            }
            if ($pushTag -match '^[Yy]$') {
                git push origin $Version
                if ($LASTEXITCODE -ne 0) { Exit-WithError "could not push git tag $Version" }
            }
        }
    }
}

# Docker login once, not once per component.
if ($env:SKIP_LOGIN -ne '1') {
    if (-not [string]::IsNullOrEmpty($env:NEXUS_USER) -and -not [string]::IsNullOrEmpty($env:NEXUS_PASSWORD)) {
        $env:NEXUS_PASSWORD | docker login $Registry -u $env:NEXUS_USER --password-stdin
        if ($LASTEXITCODE -ne 0) { Exit-WithError "docker login to $Registry failed" }
    } else {
        docker login $Registry
        if ($LASTEXITCODE -ne 0) { Exit-WithError "docker login to $Registry failed" }
    }
}

# Build metadata computed ONCE, before any build, so all four images share
# an identical immutable tag and can be correlated as a single release.
$BuildNo = $env:BUILD_NO
if ([string]::IsNullOrEmpty($BuildNo)) {
    $BuildNo = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
}
# Nepal Standard Time via the Windows tz database — no TZ env-var
# conversion needed on this platform.
$NptTime = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
    [DateTime]::UtcNow, 'Nepal Standard Time'
).ToString('yyyyMMddHHmmss')
$GitSha = (& git rev-parse --short HEAD)
if ($LASTEXITCODE -ne 0) { Exit-WithError 'could not resolve current commit sha' }
$ImmutableTag = "$Version-$BuildNo-$NptTime-$GitSha"

$TagLatest = $false
if ($Version -notmatch '-' -and $env:NO_LATEST -ne '1') {
    $TagLatest = $true
}

# A named builder is required on the LXC hosts this project's CI/CD
# convention targets (see build-push.sh's own comment) — harmless
# everywhere else, including a plain Windows/Docker Desktop host.
docker buildx create --name dtwatch-builder --use *> $null
if ($LASTEXITCODE -ne 0) {
    docker buildx use dtwatch-builder
    if ($LASTEXITCODE -ne 0) { Exit-WithError 'could not create or select the dtwatch-builder buildx builder' }
}

# Cross-build check. Uses Docker's own reported server architecture rather
# than `uname -m` (which doesn't exist on Windows) — see the port-notes
# comment at the top of this file.
$HostArch = (& docker version --format '{{.Server.Arch}}' 2>$null)
switch ($HostArch) {
    'amd64' { $NativePlatform = 'linux/amd64' }
    'arm64' { $NativePlatform = 'linux/arm64' }
    default { $NativePlatform = '' }
}
if ($Platforms -ne $NativePlatform) {
    Write-Host "Cross-building ($Platforms on $HostArch) — installing binfmt emulators"
    docker run --privileged --rm tonistiigi/binfmt --install all
}

Write-Host '============================================='
Write-Host " Registry : $Registry/$ProjectName"
Write-Host " Version  : $Version"
Write-Host " Immutable: $ImmutableTag"
Write-Host " Platforms: $Platforms"
Write-Host " Tag latest: $(if ($TagLatest) { 'yes' } else { 'no' })"
Write-Host '============================================='

# All components build concurrently against a per-image registry cache
# written with mode=max, so intermediate builder stages are reused too, not
# just the final layers. The Go compile and the Vite build are the slow
# ones here and benefit most.
function Get-BuildArgs {
    param([PSCustomObject]$Component)
    $image = "$Registry/$ProjectName/$($Component.Name)"
    $cache = "$image`:cache"
    $buildArgs = @(
        'buildx', 'build',
        '--push',
        '--platform', $Platforms,
        '-t', "$image`:$Version",
        '-t', "$image`:$ImmutableTag",
        '--cache-from', "type=registry,ref=$cache",
        '--cache-to', "type=registry,ref=$cache,mode=max",
        '-f', "$($Component.Dir)/Dockerfile"
    )
    if ($TagLatest) { $buildArgs += @('-t', "$image`:latest") }
    # Vite inlines these at build time; see the FRONTEND BUILD ARGS note in
    # build-push.sh. Only the frontend needs them.
    if ($Component.Name -eq 'frontend') {
        $buildArgs += @(
            '--build-arg', "VITE_APP_VERSION=$Version",
            '--build-arg', "VITE_BUILD_TAG=$ImmutableTag",
            '--build-arg', "VITE_GIT_SHA=$GitSha"
        )
    }
    $buildArgs += "./$($Component.Dir)"
    return $buildArgs
}

$Jobs = @()
foreach ($component in $Components) {
    Write-Host "Starting build: $($component.Name)"
    $buildArgs = Get-BuildArgs -Component $component
    $process = Start-Process -FilePath 'docker' -ArgumentList $buildArgs -NoNewWindow -PassThru -WorkingDirectory $PSScriptRoot
    $Jobs += [PSCustomObject]@{ Name = $component.Name; Process = $process }
}

$Failed = $false
foreach ($job in $Jobs) {
    $job.Process.WaitForExit()
    if ($job.Process.ExitCode -ne 0) {
        Write-Host ("{0,-14} BUILD FAILED" -f "$($job.Name):") -ForegroundColor Red
        $Failed = $true
    } else {
        Write-Host ("{0,-14} pushed" -f "$($job.Name):")
    }
}
if ($Failed) { exit 1 }

Write-Host '============================================='
Write-Host " Pushed to $Registry/$ProjectName:"
Write-Host "   :$Version"
Write-Host "   :$ImmutableTag"
if ($TagLatest) { Write-Host '   :latest' }
Write-Host '============================================='
