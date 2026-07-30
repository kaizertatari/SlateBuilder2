# Hidden launcher for refresh-bridge-task.bat — replaced refresh-bridge-task.vbs
# on 2026-07-30. Two problems with the old wscript launcher:
#   1. Fire-and-forget Run() meant the task instance "completed" in <1s, so
#      every logon stacked another orphaned restart loop and the task's
#      IgnoreNew instance policy never applied.
#   2. Stopping the task never killed the bridge: Windows terminates only the
#      task's direct process, never the tree (verified: wscript->cmd->node and
#      powershell->cmd->node both leave cmd/node orphaned on Stop).
# Fix: wrap the tree in a kill-on-close Job Object. This launcher creates the
# job, starts the .bat inside it, and waits. When Stop-ScheduledTask (or
# anything else) terminates this powershell, the kernel closes the job handle
# and reaps cmd + node + the bridge's warm Chrome — no cooperation needed.
#
# Task action: powershell.exe -NoProfile -ExecutionPolicy Bypass
#   -WindowStyle Hidden -File "<checkout>\scripts\refresh-bridge-task.ps1"

$src = @"
using System;
using System.Runtime.InteropServices;

public static class KillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
                     ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cbLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    public static IntPtr Create() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info)))
            throw new System.ComponentModel.Win32Exception();
        return job;
    }
    public static void Assign(IntPtr job, IntPtr hProcess) {
        if (!AssignProcessToJobObject(job, hProcess))
            throw new System.ComponentModel.Win32Exception();
    }
}
"@
Add-Type -TypeDefinition $src

$job = [KillOnCloseJob]::Create()
$bat = Join-Path $PSScriptRoot 'refresh-bridge-task.bat'
# The .bat's first actions (cd, mkdir, netstat duplicate guard) buy time for
# the job assignment below before any node process is spawned.
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c', "`"$bat`"" -NoNewWindow -PassThru
[KillOnCloseJob]::Assign($job, $p.Handle)
Wait-Process -Id $p.Id
