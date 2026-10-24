import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ApaManagedJob {
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimitInformation {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct StartupInformation {
    public uint cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars;
    public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInformation {
    public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInformation startupInfo, out ProcessInformation processInfo);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int standardHandle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_OBJECT_0 = 0x00000000;
  const uint INVALID_DWORD = 0xffffffff;
  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  public static IntPtr CreateKillOnCloseJob() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var info = new ExtendedLimitInformation();
    info.BasicLimitInformation.LimitFlags = 0x00002000;
    var size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
    var memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, memory, false);
      if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      return job;
    } catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(memory); }
  }
  public static string Quote(string value) {
    if (value == null || value.Length == 0) return "\"\"";
    if (value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
    var result = new StringBuilder("\""); var slashes = 0;
    foreach (var character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static void InheritStandardHandle(IntPtr handle, string name) {
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new InvalidOperationException("Managed target " + name + " handle is unavailable.");
    if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw new InvalidOperationException("Managed target " + name + " handle is not inheritable: " + Marshal.GetLastWin32Error());
  }
  static void CloseOwnedHandle(ref IntPtr handle) {
    var owned = handle;
    handle = IntPtr.Zero;
    if (owned != IntPtr.Zero && owned != new IntPtr(-1)) CloseHandle(owned);
  }
  public static int Run(string executable, string[] arguments, IntPtr job) {
    var processInfo = new ProcessInformation();
    try {
      var startupInfo = new StartupInformation();
      startupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInformation));
      startupInfo.dwFlags = STARTF_USESTDHANDLES;
      startupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
      startupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
      startupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      InheritStandardHandle(startupInfo.hStdInput, "stdin");
      InheritStandardHandle(startupInfo.hStdOutput, "stdout");
      InheritStandardHandle(startupInfo.hStdError, "stderr");
      var commandLine = new StringBuilder(Quote(executable) + (arguments == null || arguments.Length == 0 ? "" : " " + string.Join(" ", Array.ConvertAll(arguments, Quote))));
      if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startupInfo, out processInfo)) {
        throw new InvalidOperationException("CreateProcess for managed target failed: " + Marshal.GetLastWin32Error());
      }
      if (!AssignProcessToJobObject(job, processInfo.hProcess)) throw new InvalidOperationException("AssignProcessToJobObject for managed target failed: " + Marshal.GetLastWin32Error());
      if (ResumeThread(processInfo.hThread) == INVALID_DWORD) throw new InvalidOperationException("ResumeThread for managed target failed: " + Marshal.GetLastWin32Error());
      if (WaitForSingleObject(processInfo.hProcess, INFINITE) != WAIT_OBJECT_0) throw new InvalidOperationException("WaitForSingleObject for managed target failed: " + Marshal.GetLastWin32Error());
      uint exitCode;
      if (!GetExitCodeProcess(processInfo.hProcess, out exitCode)) throw new InvalidOperationException("GetExitCodeProcess for managed target failed: " + Marshal.GetLastWin32Error());
      return unchecked((int)exitCode);
    } finally {
      CloseOwnedHandle(ref processInfo.hThread);
      CloseOwnedHandle(ref processInfo.hProcess);
      CloseOwnedHandle(ref job);
    }
  }
}
`;

function windowsJobCommand(executable, arguments_) {
  const payload = Buffer.from(JSON.stringify({ executable, arguments: arguments_ }), 'utf8').toString('base64');
  const script = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${WINDOWS_JOB_SOURCE}
'@
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$job = [ApaManagedJob]::CreateKillOnCloseJob()
$exitCode = [ApaManagedJob]::Run([string]$payload.executable, [string[]]@($payload.arguments), $job)
exit $exitCode
`;
  return {
    executable: 'powershell.exe',
    arguments: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function cancellationError() {
  return new Error('Managed process cancelled.');
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function stopOwnedProcessTree(child) {
  if (!Number.isSafeInteger(child.pid)) return;
  if (process.platform === 'win32') {
    try {
      await execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } catch (cause) {
      if (cause?.code === 'ESRCH') return;
      if (!child.kill('SIGTERM')) {
        throw new Error('Managed Windows job wrapper could not be terminated after taskkill failed.');
      }
    }
    await waitForExit(child);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (cause) {
    if (cause?.code !== 'ESRCH') child.kill('SIGTERM');
  }
  await waitForExit(child);
}

export async function runManagedProcess(executable, arguments_, {
  cwd,
  env,
  signal,
  stdio = ['ignore', 'inherit', 'inherit'],
  onSpawn,
  onStdout,
  onStderr,
} = {}) {
  if (signal?.aborted) throw cancellationError();
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let teardown;
    let stderr = '';
    const command = process.platform === 'win32' ? windowsJobCommand(executable, arguments_) : { executable, arguments: arguments_ };
    const child = spawn(command.executable, command.arguments, {
      cwd,
      env,
      stdio,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const finish = (cause) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      cause ? reject(cause) : resolve();
    };
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      teardown = stopOwnedProcessTree(child);
      void teardown.then(() => finish(cancellationError()), cause => finish(cause));
    };

    child.stdout?.on('data', chunk => onStdout?.(chunk));
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
      onStderr?.(chunk);
    });
    child.once('error', cause => finish(cancelled ? cancellationError() : cause));
    child.once('exit', code => {
      if (cancelled) {
        void teardown?.then(() => finish(cancellationError()), cause => finish(cause));
      }
      else if (code === 0) finish();
      else finish(new Error(`Managed process exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    onSpawn?.(child);
    if (signal?.aborted) abort();
  });
}
