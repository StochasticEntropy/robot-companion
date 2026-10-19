"""Start an owned child process tree and stop every process in it.

POSIX: the child leads a new session/process group. Stop sends SIGTERM to the group
and SIGKILL after the grace period. Members left when the leader exits are killed
before the leader is reaped (os.waitid with WNOWAIT), while its unreaped PID keeps
the group ID reserved, so a signal can never reach a reused group ID.

Windows: the child is created suspended with
CREATE_NEW_PROCESS_GROUP, assigned to a kill-on-close Job Object and only then
resumed, so every process it starts (including the interpreter a venv's python.exe
redirector starts) is in the job. Stop is TerminateJobObject; closing the job handle,
also when this process dies, kills any member left.

POSIX-only names (os.killpg, signal.SIGKILL) and the Windows API are used only
inside their platform's functions, so this module imports on both platforms.
Every reap goes through the tree. Failed cleanup is reported, never ignored.
"""

import os
import signal
import subprocess
import sys
import threading
import time

WINDOWS = sys.platform == "win32"
STOP_TIMEOUT = 5
POLL_INTERVAL = 0.02

# Windows constants (WinBase.h/WinNT.h/TlHelp32.h), defined here because subprocess
# and ctypes only provide them on Windows.
CREATE_SUSPENDED = 0x00000004
CREATE_NEW_PROCESS_GROUP = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
THREAD_SUSPEND_RESUME = 0x0002
TH32CS_SNAPTHREAD = 0x00000004
RESUME_FAILED = 0xFFFFFFFF
TERMINATED_EXIT_CODE = 1


def popen_options(windows=WINDOWS):
    """Popen keywords that isolate the child's process tree on this platform."""
    if windows:
        return {"creationflags": CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED}
    return {"start_new_session": True}


def windows_error(action, code):
    """OSError for a failed Windows API call, with its GetLastError code."""
    return OSError(f"{action} failed (Windows error {code})")


def abnormal_exit(code):
    """Describe an exit that is not a program's own status, or None.

    Programs exit 0-255 (Robot Framework uses 0-255 for its results). A negative
    POSIX code is a signal; a larger Windows code is an NTSTATUS such as
    0xC0000005 (access violation).
    """
    if code is None or 0 <= code <= 255:
        return None
    if code < 0:
        try:
            name = signal.Signals(-code).name
        except ValueError:
            name = f"signal {-code}"
        return f"terminated by {name}"
    return f"exit status 0x{code:08X}"


class ProcessTree:
    """One started child and its descendants; `process` is its subprocess.Popen.

    Use the tree's poll/wait/stop, never the Popen's: reaping the leader elsewhere
    would release the POSIX group ID before leftover members are killed.
    `report(problems)` receives each cleanup failure as it happens.
    """

    def __init__(self, argv, report=None, **options):
        self.report = report
        self.lock = threading.Lock()
        self.reaped = False
        self.job = _WindowsJob() if WINDOWS else None
        try:
            self.process = subprocess.Popen(argv, **options, **popen_options())
        except BaseException:
            if self.job is not None:
                self.job.close()
            raise
        if self.job is not None:
            try:
                self.job.assign_and_resume(self.process.pid)
            except BaseException:
                self.process.kill()
                self.process.wait()
                self.close()
                for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
                    if pipe is not None:
                        pipe.close()
                raise

    def _problem(self, problems, detail):
        problems.append(detail)
        if self.report is not None:
            self.report([detail])

    def _killpg(self, number, problems):
        try:
            os.killpg(self.process.pid, number)
        except ProcessLookupError:
            pass  # No member of the group is left.
        except OSError as exc:
            self._problem(problems, f"cannot signal process group {self.process.pid}: {exc}")

    def _terminate_job(self, problems):
        try:
            self.job.terminate()
        except OSError as exc:
            self._problem(problems, f"cannot terminate job of process {self.process.pid}: {exc}")

    def _keeps_group(self):
        return self.job is None and hasattr(os, "waitid")

    def _exited(self):
        """True once the leader exited; with waitid a POSIX leader stays unreaped."""
        if self.process.returncode is not None:
            return True
        if self._keeps_group():
            try:
                return os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is not None
            except ChildProcessError:
                return True
        return self.process.poll() is not None

    def _reap(self, problems):
        """Kill the members the exited leader left, then reap it (once)."""
        with self.lock:
            if self.reaped:
                return
            if self.job is not None:
                self._terminate_job(problems)
            elif self.process.returncode is None or not self._keeps_group():
                # The unreaped leader keeps the group ID reserved for this tree. Without
                # waitid (not Linux) the leader may be reaped already, as before.
                self._killpg(signal.SIGKILL, problems)
            self.process.wait()
            self.reaped = True

    def _wait(self, timeout, problems):
        if self._keeps_group() and timeout is None:
            try:
                os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOWAIT)
            except ChildProcessError:
                pass
        elif self._keeps_group():
            deadline = time.monotonic() + timeout
            while not self._exited():
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(self.process.args, timeout)
                time.sleep(POLL_INTERVAL)
        else:
            self.process.wait(timeout)
        self._reap(problems)
        return self.process.returncode

    def poll(self):
        """The leader's exit code once it exited and its leftovers were killed, else None."""
        if self._exited():
            self._reap([])
            return self.process.returncode
        return None

    def wait(self, timeout=None):
        """Wait for the leader, kill its leftovers, reap it; TimeoutExpired as Popen.wait."""
        return self._wait(timeout, [])

    def stop(self, timeout=STOP_TIMEOUT):
        """Stop the whole tree (POSIX: SIGTERM, then SIGKILL after `timeout`); return failures."""
        problems = []
        if self._exited():
            self._reap(problems)
            return problems
        if self.job is not None:
            self._terminate_job(problems)  # Windows has no graceful step for a console-less tree.
        else:
            self._killpg(signal.SIGTERM, problems)
        try:
            self._wait(timeout, problems)
        except subprocess.TimeoutExpired:
            if self.job is not None:
                self._terminate_job(problems)
            else:
                self._killpg(signal.SIGKILL, problems)
            try:
                self._wait(timeout, problems)
            except subprocess.TimeoutExpired:
                self._problem(problems, f"process {self.process.pid} did not exit after it was killed")
        return problems

    def close(self):
        """Release the Windows job handle; kill-on-close ends any member left."""
        if self.job is not None:
            self.job.close()
            # Popen.wait() reaps on Windows but leaves its process HANDLE open
            # until GC. Failed launches/handshakes must release it deterministically.
            if self.process.returncode is not None:
                self.process._handle.Close()


_KERNEL32 = None


def _kernel32():
    global _KERNEL32
    if _KERNEL32 is not None:
        return _KERNEL32
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    for name, argtypes, restype in (
            ("CreateJobObjectW", (wintypes.LPVOID, wintypes.LPCWSTR), wintypes.HANDLE),
            ("SetInformationJobObject", (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD),
             wintypes.BOOL),
            ("OpenProcess", (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
            ("AssignProcessToJobObject", (wintypes.HANDLE, wintypes.HANDLE), wintypes.BOOL),
            ("TerminateJobObject", (wintypes.HANDLE, wintypes.UINT), wintypes.BOOL),
            ("CreateToolhelp32Snapshot", (wintypes.DWORD, wintypes.DWORD), wintypes.HANDLE),
            ("Thread32First", (wintypes.HANDLE, wintypes.LPVOID), wintypes.BOOL),
            ("Thread32Next", (wintypes.HANDLE, wintypes.LPVOID), wintypes.BOOL),
            ("OpenThread", (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
            ("ResumeThread", (wintypes.HANDLE,), wintypes.DWORD),
            ("CloseHandle", (wintypes.HANDLE,), wintypes.BOOL)):
        function = getattr(kernel32, name)
        function.argtypes, function.restype = argtypes, restype
    _KERNEL32 = kernel32
    return kernel32


def job_limit_structure():
    """JOBOBJECT_EXTENDED_LIMIT_INFORMATION with kill-on-close set (ctypes layout)."""
    import ctypes

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32),
                    ("SchedulingClass", ctypes.c_uint32)]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimitInformation), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    info = ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    return info


def thread_entry_structure():
    """THREADENTRY32 with dwSize set (ctypes layout)."""
    import ctypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32), ("th32ThreadID", ctypes.c_uint32),
                    ("th32OwnerProcessID", ctypes.c_uint32), ("tpBasePri", ctypes.c_int32),
                    ("tpDeltaPri", ctypes.c_int32), ("dwFlags", ctypes.c_uint32)]

    entry = ThreadEntry()
    entry.dwSize = ctypes.sizeof(entry)
    return entry


def resume_process(kernel32, pid, last_error):
    """Resume the threads of a process created suspended (Toolhelp thread snapshot)."""
    import ctypes
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        raise windows_error("CreateToolhelp32Snapshot", last_error())
    try:
        entry = thread_entry_structure()
        resumed = 0
        found = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = kernel32.OpenThread(THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if not thread:
                    raise windows_error("OpenThread", last_error())
                try:
                    if kernel32.ResumeThread(thread) == RESUME_FAILED:
                        raise windows_error("ResumeThread", last_error())
                finally:
                    kernel32.CloseHandle(thread)
                resumed += 1
            found = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        if not resumed:
            raise OSError(f"no thread of process {pid} to resume")
    finally:
        kernel32.CloseHandle(snapshot)


class _WindowsJob:
    """A kill-on-close Job Object owned by this process."""

    def __init__(self):
        import ctypes
        self.ctypes = ctypes
        self.kernel32 = _kernel32()
        self.handle = self.kernel32.CreateJobObjectW(None, None)
        if not self.handle:
            raise windows_error("CreateJobObjectW", ctypes.get_last_error())
        info = job_limit_structure()
        if not self.kernel32.SetInformationJobObject(self.handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                                                     ctypes.byref(info), ctypes.sizeof(info)):
            error = windows_error("SetInformationJobObject", ctypes.get_last_error())
            self.close()
            raise error

    def assign_and_resume(self, pid):
        process = self.kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not process:
            raise windows_error("OpenProcess", self.ctypes.get_last_error())
        try:
            if not self.kernel32.AssignProcessToJobObject(self.handle, process):
                raise windows_error("AssignProcessToJobObject", self.ctypes.get_last_error())
        finally:
            self.kernel32.CloseHandle(process)
        resume_process(self.kernel32, pid, self.ctypes.get_last_error)

    def terminate(self):
        if self.handle and not self.kernel32.TerminateJobObject(self.handle, TERMINATED_EXIT_CODE):
            raise windows_error("TerminateJobObject", self.ctypes.get_last_error())

    def close(self):
        if self.handle:
            handle, self.handle = self.handle, None
            self.kernel32.CloseHandle(handle)
