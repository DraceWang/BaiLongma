# prebuild-clean.ps1
# build 前清理 dist 目录：检测文件锁 → 优雅关闭锁定进程 → 删除旧产物

param([string]$DistPath = "dist")

$ErrorActionPreference = "Stop"
$distFull = Join-Path (Split-Path $PSScriptRoot) $DistPath

# dist 不存在则直接跳过
if (-not (Test-Path $distFull)) {
    Write-Host "[prebuild] dist 目录不存在，跳过清理" -ForegroundColor Green
    exit 0
}

$asarPath = Join-Path $distFull "win-unpacked\resources\app.asar"

# 如果 asar 不存在，直接删除 dist
if (-not (Test-Path $asarPath)) {
    Remove-Item $distFull -Recurse -Force
    Write-Host "[prebuild] dist 已清除" -ForegroundColor Green
    exit 0
}

# ── 用 Restart Manager API 找锁定进程 ──────────────────────────────────────
$rmCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RestartManager {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]  public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public int TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<int> GetLockingPids(string path) {
        var pids = new List<int>();
        uint session;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out session, 0, key) != 0) return pids;
        try {
            if (RmRegisterResources(session, 1, new[] { path }, 0, null, 0, null) != 0) return pids;
            uint needed = 0, count = 0, reboot = 0;
            RmGetList(session, out needed, ref count, null, ref reboot);
            if (needed == 0) return pids;
            var infos = new RM_PROCESS_INFO[needed];
            count = needed;
            if (RmGetList(session, out needed, ref count, infos, ref reboot) == 0)
                foreach (var i in infos) pids.Add(i.Process.dwProcessId);
        } finally {
            RmEndSession(session);
        }
        return pids;
    }
}
'@

Add-Type -TypeDefinition $rmCode

$lockingPids = [RestartManager]::GetLockingPids($asarPath)

if ($lockingPids.Count -gt 0) {
    Write-Host "[prebuild] 发现以下进程锁定了 app.asar：" -ForegroundColor Yellow
    $closedNames = @()
    foreach ($pid in $lockingPids) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  → PID $pid  $($proc.Name)  $($proc.MainWindowTitle)" -ForegroundColor Yellow
            $closedNames += $proc.Name
            # 优雅关闭（允许保存文件）
            $proc.CloseMainWindow() | Out-Null
        }
    }

    # 等待进程退出，最多 6 秒
    $deadline = (Get-Date).AddSeconds(6)
    foreach ($pid in $lockingPids) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        while ($proc -and -not $proc.HasExited -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 300
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        }
        # 超时则强制终止
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            Write-Host "  → PID $pid 未响应，强制终止" -ForegroundColor Red
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "[prebuild] 锁定进程已关闭：$($closedNames -join ', ')" -ForegroundColor Green
    Write-Host "[prebuild] 提示：build 完成后请重新打开这些应用" -ForegroundColor Cyan
    Start-Sleep -Milliseconds 500
}

# ── 删除 dist ──────────────────────────────────────────────────────────────
try {
    Remove-Item $distFull -Recurse -Force
    Write-Host "[prebuild] dist 已清除，开始 build" -ForegroundColor Green
} catch {
    Write-Host "[prebuild] 清除失败: $_" -ForegroundColor Red
    exit 1
}
