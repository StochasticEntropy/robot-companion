"""Linux-only bounded command runner with owned orphan adoption and cleanup.

This is release tooling, not a debugger capability. Subreaper state is local to
this harness process and restored on exit. No host service/config is modified.
"""

from contextlib import ExitStack
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import time


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
    return {'PATH': os.environ.get('PATH', os.defpath), 'LANG': 'C.UTF-8',
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
            'PIP_CONFIG_FILE': os.devnull, 'PIP_NO_INDEX': '1',
            'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'PIP_NO_CACHE_DIR': '1'}


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
        baseline = {pid for pid, info in processes().items() if info['parent'] == os.getpid()}
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
                                         start_new_session=True)
                self.capture(child.pid, baseline, owned)
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
