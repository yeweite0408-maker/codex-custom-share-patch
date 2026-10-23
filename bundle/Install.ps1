[CmdletBinding()]
param(
    [string]$SourceApp,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$script:PackageRoot = $PSScriptRoot
$script:ExpectedVersion = '26.1013.40934'
$script:InstallTarget = $null
$script:PatchOutput = ''

function Resolve-CodexAppDirectory {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) { return $null }
    $taskCandidate = (Resolve-Path -LiteralPath $Candidate).Path
    foreach ($taskDirectory in @($taskCandidate, (Join-Path $taskCandidate 'app'))) {
        if ((Test-Path -LiteralPath (Join-Path $taskDirectory 'ChatGPT.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $taskDirectory 'resources\app.asar') -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $taskDirectory).Path
        }
    }
    return $null
}

function Find-OfficialCodexApp {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        $taskResolved = Resolve-CodexAppDirectory -Candidate $ExplicitPath
        if (-not $taskResolved) { throw '指定目录不是有效的 Codex 应用目录：应同时包含 ChatGPT.exe 和 resources\app.asar。' }
        return $taskResolved
    }
    if (-not (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) {
        throw '无法自动发现 Microsoft Store 安装。请使用 Install.ps1 -SourceApp "官方应用目录" 指定路径。'
    }
    $taskPackages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
    foreach ($taskPackage in $taskPackages) {
        $taskResolved = Resolve-CodexAppDirectory -Candidate $taskPackage.InstallLocation
        if ($taskResolved) { return $taskResolved }
    }
    throw '未找到已安装的官方 Codex。请先通过官方渠道安装 Codex，再运行此补丁包。'
}

function Find-CompatiblePython {
    $taskCandidates = @(
        @{Name='py.exe'; Prefix=@('-3')},
        @{Name='python.exe'; Prefix=@()},
        @{Name='python3.exe'; Prefix=@()}
    )
    foreach ($taskCandidate in $taskCandidates) {
        $taskCommand = Get-Command $taskCandidate.Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $taskCommand) { continue }
        # Skip the Windows Store placeholder; it opens an installer instead of running Python.
        if ($taskCandidate.Name -ne 'py.exe' -and $taskCommand.Source -match '\\Microsoft\\WindowsApps\\python[0-9]*\.exe$') { continue }
        try {
            $taskPythonArguments = @($taskCandidate.Prefix) + @('-c', 'import sys; sys.exit(3) if sys.version_info < (3,11) else print(sys.executable)')
            $taskPythonResult = & $taskCommand.Source @taskPythonArguments 2>$null
            if ($LASTEXITCODE -eq 0) {
                $taskExecutable = [string]($taskPythonResult | Select-Object -Last 1)
                $taskExecutable = $taskExecutable.Trim()
                if (Test-Path -LiteralPath $taskExecutable -PathType Leaf) { return $taskExecutable }
            }
        } catch { }
    }
    throw '需要 Python 3.11 或更高版本。请先从 https://www.python.org/downloads/windows/ 安装，再重新运行 Install.cmd。本脚本不会自动下载软件或修改系统安全设置。'
}

function New-PrivateCodexTarget {
    param([string]$OfficialApp)
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw '无法确定当前用户的 LocalAppData 目录。' }
    $taskRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexCustom'))
    $taskVersionName = $script:ExpectedVersion + '-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskVersionName))
    $taskSource = [IO.Path]::GetFullPath($OfficialApp).TrimEnd('\')
    if (-not $taskTarget.StartsWith($taskRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装目标超出预期目录。' }
    if ($taskTarget.Equals($taskSource, [StringComparison]::OrdinalIgnoreCase) -or
        $taskTarget.StartsWith($taskSource + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '补丁不能安装到官方应用目录中。' }
    if (Test-Path -LiteralPath $taskTarget) { throw '目标目录已经存在。补丁不会覆盖已有定制版。' }
    $taskRunning = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($taskRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    if ($taskRunning.Count -gt 0) { throw '已有 Codex Custom 正在运行。请完全退出该定制版后重试；本脚本不会强制关闭窗口。' }
    if (-not (Test-Path -LiteralPath $taskRoot)) { New-Item -ItemType Directory -Path $taskRoot | Out-Null }
    New-Item -ItemType Directory -Path $taskTarget | Out-Null
    return $taskTarget
}

function Copy-OfficialAppFiles {
    param([string]$OfficialApp, [string]$PrivateApp)
    if (-not (Test-Path -LiteralPath $PrivateApp -PathType Container)) { throw '定制应用目标目录不存在。' }
    if (@(Get-ChildItem -LiteralPath $PrivateApp -Force).Count -ne 0) { throw '复制目标必须是空目录。' }
    # This is the immutable installation directory, never a profile or .codex directory.
    foreach ($taskEntry in Get-ChildItem -LiteralPath $OfficialApp -Force) {
        Copy-Item -LiteralPath $taskEntry.FullName -Destination $PrivateApp -Recurse
    }
}

function Set-CustomCodexShortcut {
    param([string]$PrivateApp, [string]$ProfileDirectory)
    $taskExe = Join-Path $PrivateApp 'ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $taskExe -PathType Leaf)) { throw '安装后的程序文件缺失，未创建快捷方式。' }
    $taskPrograms = [Environment]::GetFolderPath('Programs')
    if ([string]::IsNullOrWhiteSpace($taskPrograms)) { throw '无法确定当前用户的开始菜单目录。' }
    $taskShell = New-Object -ComObject WScript.Shell
    $taskShortcut = $taskShell.CreateShortcut((Join-Path $taskPrograms 'Codex Custom.lnk'))
    $taskShortcut.TargetPath = $taskExe
    $taskShortcut.Arguments = '--user-data-dir="' + $ProfileDirectory + '"'
    $taskShortcut.WorkingDirectory = $PrivateApp
    $taskShortcut.WindowStyle = 1
    $taskIcon = Join-Path $PrivateApp 'resources\icon-chatgpt.ico'
    if (Test-Path -LiteralPath $taskIcon -PathType Leaf) { $taskShortcut.IconLocation = $taskIcon + ',0' }
    $taskShortcut.Description = 'Local Codex customization: wallpaper settings, usage footer and optional auto-resume'
    $taskShortcut.Save()
}

function Save-InstallerFailure {
    param([string]$Message)
    $taskLines = @('Codex Custom patch installation failed', ('Time: ' + [DateTime]::UtcNow.ToString('o')),
        ('Expected source version: ' + $script:ExpectedVersion), ('Target: ' + $script:InstallTarget),
        ('Error: ' + $Message), '', $script:PatchOutput)
    $taskLogRoot = if ($script:InstallTarget -and (Test-Path -LiteralPath $script:InstallTarget)) { $script:InstallTarget } else { $script:PackageRoot }
    $taskLog = Join-Path $taskLogRoot ('install-error-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.log')
    try { $taskLines | Set-Content -LiteralPath $taskLog -Encoding UTF8; Write-Host ('诊断日志：' + $taskLog) } catch { }
}

function Invoke-CodexCustomInstallation {
    param([string]$OfficialPath, [switch]$SkipLaunch)
    $taskPatcher = Join-Path $script:PackageRoot 'payload\build_native_wallpaper.py'
    if (-not (Test-Path -LiteralPath $taskPatcher -PathType Leaf)) { throw '补丁包不完整：缺少 payload\build_native_wallpaper.py。请先完整解压 ZIP。' }
    $taskPython = Find-CompatiblePython
    $taskSource = Find-OfficialCodexApp -ExplicitPath $OfficialPath
    Write-Host ('官方应用目录：' + $taskSource)
    Write-Host ('此补丁仅适配 Codex ' + $script:ExpectedVersion + '，后续由补丁程序校验原始资源版本。')
    $taskCheckArguments = @($taskPatcher, '--source', $taskSource, '--check-source')
    $taskPreviousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $script:PatchOutput = (& $taskPython @taskCheckArguments 2>&1 | Out-String)
        $taskCheckExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreviousErrorAction }
    if ($taskCheckExit -ne 0) { throw ('当前官方版本不受此补丁支持。仅支持 ' + $script:ExpectedVersion + ' 原始资源；尚未复制或修改任何应用。' + [Environment]::NewLine + $script:PatchOutput) }
    $taskTarget = New-PrivateCodexTarget -OfficialApp $taskSource
    $script:InstallTarget = $taskTarget
    Write-Host ('正在创建独立副本：' + $taskTarget)
    Copy-OfficialAppFiles -OfficialApp $taskSource -PrivateApp $taskTarget
    $taskPatcherArguments = @($taskPatcher, '--source', $taskSource, '--target', $taskTarget, '--portable', '--usage-footer', '--auto-resume', '--wallpaper-settings')
    $taskPreviousErrorAction = $ErrorActionPreference
    try {
        # Capture native stderr on Windows PowerShell 5.1 without losing diagnostics.
        $ErrorActionPreference = 'Continue'
        $script:PatchOutput = (& $taskPython @taskPatcherArguments 2>&1 | Out-String)
        $taskPatchExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreviousErrorAction }
    if ($script:PatchOutput) { Write-Host $script:PatchOutput }
    if ($taskPatchExit -ne 0) { throw ('补丁构建失败（退出码 ' + $taskPatchExit + '）。可能是官方版本不匹配。已保留诊断目录，未更改快捷方式。') }
    $taskManifestPath = Join-Path $taskTarget 'native-wallpaper-build.json'
    if (-not (Test-Path -LiteralPath $taskManifestPath -PathType Leaf)) { throw '补丁未生成构建清单，未更改快捷方式。' }
    $taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
    if (-not $taskManifest.patchedExeSHA256 -or
        (Get-FileHash -LiteralPath (Join-Path $taskTarget 'ChatGPT.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskManifest.patchedExeSHA256) {
        throw '安装后的程序校验失败，未更改快捷方式。'
    }
    $taskProfile = Join-Path (Split-Path -Parent $taskTarget) 'UserData'
    Set-CustomCodexShortcut -PrivateApp $taskTarget -ProfileDirectory $taskProfile
    Write-Host '安装完成。开始菜单入口：Codex Custom'
    Write-Host '对方使用自己的本机账号；此补丁包未包含发送者的登录、聊天或壁纸文件。'
    if (-not $SkipLaunch) {
        Start-Process -FilePath (Join-Path $taskTarget 'ChatGPT.exe') -ArgumentList ('--user-data-dir="' + $taskProfile + '"') -WorkingDirectory $taskTarget -WindowStyle Normal
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-CodexCustomInstallation -OfficialPath $SourceApp -SkipLaunch:$NoLaunch
    } catch {
        Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
        Save-InstallerFailure -Message $_.Exception.ToString()
        exit 1
    }
}
