"""Owned-process observation for the live suites: Linux `/proc`, Windows a Toolhelp32
process snapshot (never `/proc`).

An identity is `{"parent", "start", "group", "state", "image"}`; `start` (the kernel start
time on Linux, the creation FILETIME on Windows) tells a live process from a reused PID.
`group` is the POSIX process group (None on Windows); `state` is the `/proc` state letter,
on Windows `"R"` while running and `"Z"` once exited but still referenced.
"""

import os
from pathlib import Path
import signal
import socket
import struct
import sys
import time

WINDOWS = sys.platform == "win32"


def snapshot():
    """{pid: identity} of every observable process; fails rather than returning nothing."""
    return _windows_snapshot() if WINDOWS else _proc_snapshot()


def identity(pid):
    return snapshot().get(pid)


def children(pid, table=None):
    """Direct child processes of pid, including exited-but-unreaped ones."""
    table = snapshot() if table is None else table
    parent = table.get(pid)
    found = []
    for child, info in table.items():
        if info["parent"] != pid or child == pid:
            continue
        # A Windows parent PID may name a newer process that reused it.
        if WINDOWS and parent is not None and None not in (parent["start"], info["start"]) \
                and info["start"] < parent["start"]:
            continue
        found.append(child)
    return sorted(found)


def descendants(pid, table=None):
    """Every process below pid, at any depth (only while each intermediate parent lives on
    Windows; use `alive` on identities captured earlier for orphans)."""
    table = snapshot() if table is None else table
    found, frontier = {}, [pid]
    while frontier:
        parent = frontier.pop()
        for child in children(parent, table):
            if child not in found:
                found[child] = table[child]
                frontier.append(child)
    return found


def alive(owned):
    """The captured identities still running (same PID and start, not exited)."""
    table = snapshot()
    return {pid: info for pid, info in owned.items() if pid in table
            and table[pid]["start"] == info["start"] and table[pid]["state"] != "Z"}


def interpreter_pid(pid, exited=lambda: False, timeout=10):
    """PID of the Python interpreter of a process started from sys.executable or a console
    script. On Windows a venv's python.exe is a launcher that starts the base interpreter as
    its only child, and an installed console script's .exe launches that python.exe; the
    single-child chain is followed down to the base interpreter. POSIX starts it directly."""
    if not WINDOWS or getattr(sys, "_base_executable", sys.executable) == sys.executable:
        return pid
    base = os.path.normcase(os.path.realpath(sys._base_executable))
    deadline = time.monotonic() + timeout
    current = pid
    while True:
        if exited():
            raise AssertionError(f"Cannot resolve interpreter of exited launcher {pid}; capture it while live")
        if os.path.normcase(os.path.realpath(image_path(current))) == base:
            return current
        found = children(current)
        if len(found) == 1:
            current = found[0]
            continue
        if len(found) > 1 or time.monotonic() > deadline or exited():
            raise AssertionError(f"Expected one launcher chain from {pid} to {base}, found {found} below {current}")
        time.sleep(0.05)


def _windows_tcp_listeners(data):
    """Decode MIB_TCPTABLE; only LISTEN is a listener, never TIME_WAIT."""
    if len(data) < 4:
        raise RuntimeError("Truncated Windows TCP table header")
    count, = struct.unpack_from("<I", data)
    if count > (len(data) - 4) // 20:
        raise RuntimeError("Truncated Windows TCP table rows")
    found = set()
    for index in range(count):
        state, address, port, _, _ = struct.unpack_from("<5I", data, 4 + 20 * index)
        if state == 2:  # MIB_TCP_STATE_LISTEN
            found.add((socket.inet_ntoa(struct.pack("<I", address)), socket.ntohs(port & 0xffff)))
    return found


def tcp_listeners():
    """Observe actual IPv4 listeners through the OS, failing on unavailable observation."""
    if not WINDOWS:
        found = set()
        for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) < 4:
                raise RuntimeError("Malformed Linux TCP table")
            if fields[3] == "0A":
                address, port = fields[1].split(":")
                found.add((socket.inet_ntoa(bytes.fromhex(address)[::-1]), int(port, 16)))
        return found
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL("iphlpapi").GetTcpTable
    api.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.ULONG), wintypes.BOOL)
    api.restype = wintypes.ULONG
    size = wintypes.ULONG()
    code = api(None, ctypes.byref(size), False)
    if code != 122:  # ERROR_INSUFFICIENT_BUFFER is required for a null buffer.
        raise ctypes.WinError(code)
    for _ in range(4):  # The connection table can grow between the two calls.
        if size.value < 4 or size.value > 16 * 1024 * 1024:
            raise RuntimeError("Invalid Windows TCP table size")
        buffer = ctypes.create_string_buffer(size.value)
        code = api(buffer, ctypes.byref(size), False)
        if code == 0:
            return _windows_tcp_listeners(buffer.raw[:size.value])
        if code != 122:
            raise ctypes.WinError(code)
    raise RuntimeError("Windows TCP table kept changing during observation")


def assert_no_listener(test, host, port, timeout=10):
    """Prove LISTEN disappeared independently of connect errors and TIME_WAIT binds."""
    deadline = time.monotonic() + timeout
    while True:
        current = tcp_listeners()
        if (host, port) not in current and ("0.0.0.0", port) not in current:
            return
        if time.monotonic() >= deadline:
            test.fail(f"Control listener {host}:{port} remains in the OS TCP table")
        time.sleep(0.05)


def kill(pid, info):
    """Kill one captured identity (its POSIX group if it leads one); never a reused PID."""
    current = identity(pid)
    if current is None or current["start"] != info["start"] or current["state"] == "Z":
        return False
    if WINDOWS:
        return _windows_terminate(pid)
    try:
        if current["group"] == pid:
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return False
    return True


def handle_count(pid):
    """Open file descriptors (Linux) or kernel handles (Windows) of pid."""
    if not WINDOWS:
        return len(list(Path(f"/proc/{pid}/fd").iterdir()))
    import ctypes
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        count = ctypes.c_ulong()
        if not kernel32.GetProcessHandleCount(handle, ctypes.byref(count)):
            raise ctypes.WinError(ctypes.get_last_error())
        return count.value
    finally:
        kernel32.CloseHandle(handle)


# Linux compares the exact descriptor count after one attempt. Windows handle counts move with
# thread-pool activity, so an attempt is repeated: a leak of one handle per attempt would add at
# least HANDLE_REPEATS handles, which is what assert_no_handle_leak refuses.
HANDLE_REPEATS = 20 if WINDOWS else 1


def assert_no_handle_leak(test, pid, before):
    after = handle_count(pid)
    if WINDOWS:
        test.assertLess(after - before, HANDLE_REPEATS,
                        f"{after - before} more handles after {HANDLE_REPEATS} failed attempts")
    else:
        test.assertEqual(after, before)


def processes_in(directory):
    """Processes whose working directory is directory, at any depth or after reparenting.

    Linux reads every /proc/<pid>/cwd. Windows does not expose another process's working
    directory; a process's current-directory handle (or any open file below it) makes renaming
    the directory fail with an access or sharing error, so a rename that keeps failing for
    2 seconds is reported as one unnamed holder, `["holder of <directory>"]`."""
    if not WINDOWS:
        if not Path("/proc/self/cwd").is_symlink():
            raise RuntimeError("Process observation requires Linux /proc or a Windows process snapshot")
        found = []
        for link in Path("/proc").glob("[0-9]*/cwd"):
            try:
                if Path(os.readlink(link)) == directory:
                    found.append(int(link.parent.name))
            except OSError:
                continue
        return found
    directory = Path(directory)
    probe = directory.with_name(directory.name + ".rename-probe")
    deadline = time.monotonic() + 2
    while True:
        try:
            directory.rename(probe)
        except PermissionError:
            if time.monotonic() > deadline:
                return [f"holder of {directory}"]
            time.sleep(0.05)
            continue
        probe.rename(directory)
        return []


def argv(pid):
    """The argument vector of pid (Windows: its command line split by the C runtime rules)."""
    if not WINDOWS:
        return [a.decode() for a in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if a]
    return _split_windows_command_line(command_line(pid))


def command_line(pid):
    """The command line of pid as the OS recorded it."""
    if not WINDOWS:
        return " ".join(argv(pid))
    import ctypes
    from ctypes import wintypes
    kernel32, ntdll = _kernel32(), ctypes.WinDLL("ntdll")
    ntdll.NtQueryInformationProcess.argtypes = (wintypes.HANDLE, ctypes.c_ulong, ctypes.c_void_p,
                                                ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong))
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = ctypes.c_ulong(0)
        ntdll.NtQueryInformationProcess(handle, 60, None, 0, ctypes.byref(size))  # ProcessCommandLineInformation
        buffer = ctypes.create_string_buffer(size.value or 65536)
        status = ntdll.NtQueryInformationProcess(handle, 60, buffer, len(buffer), ctypes.byref(size))
        if status < 0:
            raise OSError(f"NtQueryInformationProcess failed: 0x{status & 0xFFFFFFFF:08X}")

        class UnicodeString(ctypes.Structure):
            _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort),
                        ("Buffer", ctypes.c_void_p)]
        text = UnicodeString.from_buffer(buffer)
        return ctypes.wstring_at(text.Buffer, text.Length // 2)
    finally:
        kernel32.CloseHandle(handle)


def image_path(pid):
    """The executable file of pid."""
    if not WINDOWS:
        return os.path.realpath(f"/proc/{pid}/exe")
    import ctypes
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = ctypes.c_ulong(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.value
    finally:
        kernel32.CloseHandle(handle)


def _proc_snapshot():
    if not Path("/proc/self/stat").is_file():
        raise RuntimeError("Process observation requires Linux /proc or a Windows process snapshot")
    table = {}
    for entry in Path("/proc").glob("[0-9]*"):
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            table[int(entry.name)] = {"parent": int(fields[1]), "group": int(fields[2]),
                                      "start": fields[19], "state": fields[0], "image": None}
        except (OSError, ValueError, IndexError):
            continue
    return table


PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
TH32CS_SNAPPROCESS = 0x00000002
TERMINATED_BY_TEST = 0xC000013A  # STATUS_CONTROL_C_EXIT: a deliberate outside kill
_KERNEL32 = None


def _kernel32():
    global _KERNEL32
    if _KERNEL32 is None:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        for name, argtypes, restype in (
                ("CreateToolhelp32Snapshot", (wintypes.DWORD, wintypes.DWORD), wintypes.HANDLE),
                ("Process32FirstW", (wintypes.HANDLE, ctypes.c_void_p), wintypes.BOOL),
                ("Process32NextW", (wintypes.HANDLE, ctypes.c_void_p), wintypes.BOOL),
                ("OpenProcess", (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
                ("GetProcessTimes", (wintypes.HANDLE,) + (ctypes.POINTER(ctypes.c_ulonglong),) * 4, wintypes.BOOL),
                ("GetExitCodeProcess", (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)), wintypes.BOOL),
                ("GetProcessHandleCount", (wintypes.HANDLE, ctypes.POINTER(ctypes.c_ulong)), wintypes.BOOL),
                ("QueryFullProcessImageNameW", (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                ctypes.POINTER(ctypes.c_ulong)), wintypes.BOOL),
                ("TerminateProcess", (wintypes.HANDLE, wintypes.UINT), wintypes.BOOL),
                ("CloseHandle", (wintypes.HANDLE,), wintypes.BOOL)):
            function = getattr(kernel32, name)
            function.argtypes, function.restype = argtypes, restype
        _KERNEL32 = kernel32
    return _KERNEL32


def _process_entry():
    import ctypes
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):  # PROCESSENTRY32W
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]
    entry = ProcessEntry()
    entry.dwSize = ctypes.sizeof(ProcessEntry)
    return entry


def _windows_snapshot():
    import ctypes
    kernel32 = _kernel32()
    snapshot_handle = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot_handle in (None, ctypes.c_void_p(-1).value):
        raise ctypes.WinError(ctypes.get_last_error())
    entries = []
    try:
        entry = _process_entry()
        more = kernel32.Process32FirstW(snapshot_handle, ctypes.byref(entry))
        while more:
            entries.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            more = kernel32.Process32NextW(snapshot_handle, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot_handle)
    if not entries:
        raise RuntimeError("The Windows process snapshot is empty")
    table = {}
    for pid, parent, image in entries:
        start, state = _windows_times(pid)
        table[pid] = {"parent": parent, "group": None, "start": start, "state": state, "image": image}
    return table


def _windows_times(pid):
    """(creation FILETIME, "R"/"Z") or (None, "R") for a process this user cannot open."""
    import ctypes
    from ctypes import wintypes
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None, "R"
    try:
        creation, exit_, kernel, user = (ctypes.c_ulonglong() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            return None, "R"
        code = wintypes.DWORD()
        state = "R"
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value != STILL_ACTIVE:
            state = "Z"
        return creation.value, state
    finally:
        kernel32.CloseHandle(handle)


def _windows_terminate(pid):
    import ctypes
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        return bool(kernel32.TerminateProcess(handle, TERMINATED_BY_TEST))
    finally:
        kernel32.CloseHandle(handle)


def _split_windows_command_line(line):
    """argv as the Microsoft C runtime parses a command line (CommandLineToArgvW rules)."""
    argv, current, quoted, index, pending = [], [], False, 0, False
    while index < len(line):
        character = line[index]
        if character == "\\":
            slashes = 0
            while index < len(line) and line[index] == "\\":
                slashes += 1
                index += 1
            if index < len(line) and line[index] == '"':
                current.append("\\" * (slashes // 2))
                if slashes % 2:
                    current.append('"')
                    index += 1
            else:
                current.append("\\" * slashes)
            pending = True
            continue
        if character == '"':
            quoted = not quoted
            pending = True
        elif character in " \t" and not quoted:
            if pending:
                argv.append("".join(current))
                current, pending = [], False
        else:
            current.append(character)
            pending = True
        index += 1
    if pending:
        argv.append("".join(current))
    return argv
