"""Start an owned child process tree and stop every process in it.

POSIX: the child leads a new session/process group; stop sends SIGTERM to the group,
SIGKILL after the grace period, reaps the leader and kills group members that
outlived it. Windows (not Windows-verified): the child gets
CREATE_NEW_PROCESS_GROUP and is assigned to a kill-on-close Job Object before it is
given any work; stop sends CTRL_BREAK_EVENT to the group, then TerminateJobObject.
A Job Object contains the grandchildren the child starts after assignment.

POSIX-only names (os.killpg, signal.SIGKILL) and the Windows API are used only
inside their platform's functions, so this module imports on both platforms.
Failed cleanup is returned to the caller, never ignored.
"""

import os
import signal
import subprocess
import sys

WINDOWS = sys.platform == "win32"
STOP_TIMEOUT = 5

# Windows constants (WinBase.h/WinNT.h), defined here because subprocess and
# ctypes only provide them on Windows.
CREATE_NEW_PROCESS_GROUP = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
TERMINATED_EXIT_CODE = 1


def popen_options(windows=WINDOWS):
    """Popen keywords that isolate the child's process tree on this platform."""
    if windows:
        return {"creationflags": CREATE_NEW_PROCESS_GROUP}
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
    """One started child and its descendants; `process` is its subprocess.Popen."""

    def __init__(self, argv, **options):
        self.job = _WindowsJob() if WINDOWS else None
        try:
            self.process = subprocess.Popen(argv, **options, **popen_options())
        except BaseException:
            if self.job is not None:
                self.job.close()
            raise
        if self.job is not None:
            try:
                self.job.assign(self.process.pid)
            except OSError:
                self.process.kill()
                self.process.wait()
                self.job.close()
                raise

    def _signal(self, force):
        """Signal every remaining tree member; return a failure description or None."""
        if self.job is not None:
            if not force:
                try:  # Reaches the group only when it shares this process's console.
                    os.kill(self.process.pid, signal.CTRL_BREAK_EVENT)
                    return None
                except OSError:
                    force = True
            try:
                self.job.terminate()
            except OSError as exc:
                return f"cannot terminate job of process {self.process.pid}: {exc}"
            return None
        try:
            os.killpg(self.process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            pass  # No member of the group is left.
        except OSError as exc:
            return f"cannot signal process group {self.process.pid}: {exc}"
        return None

    def kill(self):
        """Force-kill remaining members (also after the leader exited); return failures."""
        problem = self._signal(force=True)
        return [problem] if problem else []

    def stop(self, timeout=STOP_TIMEOUT):
        """Stop gracefully, force after `timeout`, reap the leader; return failures."""
        problems = []
        if self.process.poll() is None:
            if problem := self._signal(force=False):
                problems.append(problem)
            try:
                self.process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                problems.extend(self.kill())
                try:
                    self.process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    problems.append(f"process {self.process.pid} did not exit after it was killed")
        problems.extend(self.kill())
        return problems

    def close(self):
        """Release the Windows job handle; kill-on-close ends any member left."""
        if self.job is not None:
            self.job.close()


def _kernel32():
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
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


class _WindowsJob:
    """A kill-on-close Job Object owned by this process (not Windows-verified)."""

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

    def assign(self, pid):
        process = self.kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not process:
            raise windows_error("OpenProcess", self.ctypes.get_last_error())
        try:
            if not self.kernel32.AssignProcessToJobObject(self.handle, process):
                raise windows_error("AssignProcessToJobObject", self.ctypes.get_last_error())
        finally:
            self.kernel32.CloseHandle(process)

    def terminate(self):
        if self.handle and not self.kernel32.TerminateJobObject(self.handle, TERMINATED_EXIT_CODE):
            raise windows_error("TerminateJobObject", self.ctypes.get_last_error())

    def close(self):
        if self.handle:
            handle, self.handle = self.handle, None
            self.kernel32.CloseHandle(handle)
