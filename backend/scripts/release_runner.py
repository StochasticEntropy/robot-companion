"""Bounded command runner with owned-process cleanup: Linux and Windows.

This is release tooling, not a debugger capability. On Linux the runner adopts
orphans as a subreaper (local to this harness process, restored on exit) and
observes /proc. On Windows every command starts suspended inside its own Job
Object, so all its descendants, orphans included, stay observable as job members
(never /proc); members left after the command are killed and reported. No host
service/config is modified.
"""

from contextlib import ExitStack
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

WINDOWS = sys.platform == 'win32'


def processes():
    if not Path('/proc/self/stat').is_file():
        raise RuntimeError('Release process observation requires Linux /proc')
    result = {}
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            result[int(entry.name)] = {'parent': int(fields[1]), 'group': int(fields[2]),
                                       'start': fields[19], 'state': fields[0]}
        except (OSError, ValueError, IndexError):
            continue
    return result


def safe_environment():
    # Do not pass task credentials, user-site configuration, Python source paths,
    # proxy configuration or pip credentials into build/test subprocesses.
    env = {'PATH': os.environ.get('PATH', os.defpath), 'LANG': 'C.UTF-8',
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
           'PIP_CONFIG_FILE': os.devnull, 'PIP_NO_INDEX': '1',
           'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'PIP_NO_CACHE_DIR': '1'}
    if WINDOWS:
        # Windows processes need their system location and temporary directory; Python's
        # default (locale) encodings stay as on the user's machine (no UTF-8 mode).
        env.update({name: os.environ[name] for name in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')
                    if name in os.environ})
    return env


class Runner:
    def __init__(self, evidence, timeout=300, grace=5):
        self.evidence = Path(evidence)
        self.timeout = timeout
        self.grace = grace
        self.libc = None
        self.old_subreaper = ctypes.c_int()

    def __enter__(self):
        processes()  # Fail explicitly rather than treating absent observation as cleanup.
        self.libc = ctypes.CDLL(None, use_errno=True)
        if self.libc.prctl(37, ctypes.byref(self.old_subreaper), 0, 0, 0) != 0 \
                or self.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot establish owned-process subreaper')
        return self

    def __exit__(self, *args):
        if self.libc is not None and self.libc.prctl(36, self.old_subreaper.value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot restore process subreaper state')

    def baseline(self):
        return {pid for pid, info in processes().items() if info['parent'] == os.getpid()}

    def popen_options(self):
        return {'start_new_session': True}

    def started(self, child, baseline, owned):
        self.capture(child.pid, baseline, owned)

    def capture(self, root, baseline, owned):
        current = processes()
        parents = {root}
        # Orphans from this command are adopted by this runner, including ones
        # that deliberately started separate sessions/process groups.
        parents.update(pid for pid, info in current.items()
                       if info['parent'] == os.getpid() and pid not in baseline)
        while found := {pid for pid, info in current.items() if info['parent'] in parents and pid not in parents}:
            parents.update(found)
        for pid in parents:
            if pid in current and pid not in baseline and pid != os.getpid():
                owned.setdefault(pid, current[pid])
        return current

    def survivors(self, owned):
        current = processes()
        return {pid: info for pid, info in current.items()
                if pid in owned and info['start'] == owned[pid]['start']}

    def reap(self, owned):
        for pid in list(owned):
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass

    def signal_owned(self, owned, sig):
        for pid, info in self.survivors(owned).items():
            if info['state'] == 'Z':
                continue
            try:
                if info['group'] == pid:
                    os.killpg(pid, sig)
                else:
                    os.kill(pid, sig)
            except ProcessLookupError:
                pass

    def cleanup(self, root, baseline, owned):
        self.capture(root, baseline, owned)
        self.reap(owned)
        needed = bool(self.survivors(owned))
        if not needed:
            return False, []
        self.signal_owned(owned, signal.SIGTERM)
        deadline = time.monotonic() + self.grace
        while self.survivors(owned) and time.monotonic() < deadline:
            self.capture(root, baseline, owned)
            self.reap(owned)
            time.sleep(0.02)
        # Capture descendants adopted while their parents were terminating.
        self.capture(root, baseline, owned)
        self.signal_owned(owned, signal.SIGKILL)
        deadline = time.monotonic() + self.grace
        while self.survivors(owned) and time.monotonic() < deadline:
            self.capture(root, baseline, owned)
            self.signal_owned(owned, signal.SIGKILL)
            self.reap(owned)
            time.sleep(0.02)
        return True, sorted(self.survivors(owned))

    def run(self, name, argv, cwd, env, separate_stdout=False):
        log = self.evidence / (name + '.txt')
        baseline = self.baseline()
        owned = {}
        receipt = {'name': name, 'command': [str(a) for a in argv], 'cwd': str(cwd),
                   'timeoutSeconds': self.timeout, 'timedOut': False, 'log': str(log)}
        child = None
        try:
            with ExitStack() as handles:
                output = handles.enter_context(log.open('x'))
                if separate_stdout:
                    stdout_path = self.evidence / (name + '.stdout')
                    stdout = handles.enter_context(stdout_path.open('xb'))
                    receipt['stdout'] = str(stdout_path)
                else:
                    stdout = output
                child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                         stdout=stdout, stderr=output if separate_stdout else subprocess.STDOUT,
                                         **self.popen_options())
                self.started(child, baseline, owned)
                try:
                    code = child.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    receipt['timedOut'] = True
                    # Stop the command first; adoption then makes every remaining
                    # descendant observable, even after it changed process group.
                    child.terminate()
                    try:
                        child.wait(timeout=self.grace)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=self.grace)
                    code = child.returncode
                receipt['processExit'] = code
                receipt['exit'] = 124 if receipt['timedOut'] else code
        except (OSError, ValueError) as exc:
            receipt.update(exit=127, error=f'{type(exc).__name__}: {exc}')
        except BaseException as exc:
            receipt.update(exit=130, error=f'{type(exc).__name__}: {exc}')
            raise
        finally:
            if child is not None:
                needed, remaining = self.cleanup(child.pid, baseline, owned)
                receipt.update(cleanupNeeded=needed, cleanupSurvivors=remaining)
            else:
                receipt.update(cleanupNeeded=False, cleanupSurvivors=[])
            receipt['passed'] = receipt['exit'] == 0 and not receipt['cleanupNeeded'] and not receipt['cleanupSurvivors']
            temporary = self.evidence / (name + '.json.tmp')
            temporary.write_text(json.dumps(receipt, indent=2))
            temporary.replace(self.evidence / (name + '.json'))
        return receipt


class WindowsRunner(Runner):
    """Each command runs in a new kill-on-close Job Object; its members are the owned processes."""

    def __init__(self, evidence, timeout=300, grace=5):
        super().__init__(evidence, timeout, grace)
        self.jobs = {}

    def __enter__(self):
        self.kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        self.ntdll = ctypes.WinDLL('ntdll')
        from ctypes import wintypes
        for name, argtypes, restype in (
                ('CreateJobObjectW', (ctypes.c_void_p, wintypes.LPCWSTR), wintypes.HANDLE),
                ('SetInformationJobObject', (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD),
                 wintypes.BOOL),
                ('QueryInformationJobObject', (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                               ctypes.c_void_p), wintypes.BOOL),
                ('AssignProcessToJobObject', (wintypes.HANDLE, wintypes.HANDLE), wintypes.BOOL),
                ('TerminateJobObject', (wintypes.HANDLE, wintypes.UINT), wintypes.BOOL),
                ('CloseHandle', (wintypes.HANDLE,), wintypes.BOOL)):
            function = getattr(self.kernel32, name)
            function.argtypes, function.restype = argtypes, restype
        self.ntdll.NtResumeProcess.argtypes = (wintypes.HANDLE,)
        self.ntdll.NtResumeProcess.restype = ctypes.c_long
        return self

    def __exit__(self, *args):
        for job in self.jobs.values():
            self.kernel32.CloseHandle(job)  # kill-on-close: nothing outlives the runner
        self.jobs.clear()

    def baseline(self):
        return set()

    def popen_options(self):
        return {'creationflags': 0x00000004 | 0x00000200}  # CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP

    def error(self, action):
        return OSError(f'{action} failed (Windows error {ctypes.get_last_error()})')

    def started(self, child, baseline, owned):
        job = self.kernel32.CreateJobObjectW(None, None)
        if not job:
            child.kill()
            raise self.error('CreateJobObjectW')
        self.jobs[child.pid] = job

        class Basic(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                        ('LimitFlags', ctypes.c_uint32), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', ctypes.c_uint32),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', ctypes.c_uint32),
                        ('SchedulingClass', ctypes.c_uint32)]

        class Extended(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', ctypes.c_uint64 * 6),
                        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) \
                or not self.kernel32.AssignProcessToJobObject(job, int(child._handle)):
            error = self.error('Job Object setup')
            child.kill()
            raise error
        # Resumed only once assigned, so every process it starts is a member.
        if self.ntdll.NtResumeProcess(int(child._handle)) < 0:
            child.kill()
            raise OSError('NtResumeProcess failed')

    def members(self, job):
        """PIDs of the job's live members (JobObjectBasicProcessIdList)."""
        class ProcessIds(ctypes.Structure):
            _fields_ = [('NumberOfAssignedProcesses', ctypes.c_uint32), ('NumberOfProcessIdsInList', ctypes.c_uint32),
                        ('ProcessIdList', ctypes.c_size_t * 1024)]
        ids = ProcessIds()
        if not self.kernel32.QueryInformationJobObject(job, 3, ctypes.byref(ids), ctypes.sizeof(ids), None):
            raise self.error('QueryInformationJobObject')
        return sorted(ids.ProcessIdList[i] for i in range(ids.NumberOfProcessIdsInList))

    def cleanup(self, root, baseline, owned):
        job = self.jobs.pop(root, None)
        if job is None:  # the job could not be set up; the command was killed at once
            return False, []
        try:
            left = self.members(job)
            if not left:
                return False, []
            owned.update({pid: {} for pid in left})
            if not self.kernel32.TerminateJobObject(job, 1):
                raise self.error('TerminateJobObject')
            deadline = time.monotonic() + self.grace
            while (left := self.members(job)) and time.monotonic() < deadline:
                time.sleep(0.02)
            return True, left
        finally:
            self.kernel32.CloseHandle(job)


if WINDOWS:
    Runner = WindowsRunner
