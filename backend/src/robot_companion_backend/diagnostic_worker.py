"""Owned push-diagnostics worker, isolated from the request workspace and its imports."""

from pathlib import Path
import subprocess
import sys
import threading

from . import diagnostics, project
from .process_tree import ProcessTree
from .protocol import FramedStream
from .workspace import Workspace, uri_path


class DiagnosticsWorker:
    """One analysis in progress and one latest snapshot; obsolete results are never published."""

    def __init__(self, notify):
        self.notify = notify
        self.condition = threading.Condition()
        self.generation = 0
        self.pending = None
        self.closed = False
        self.tree = None
        self.thread = None
        self.cleanup_problems = []

    def _cleanup_problem(self, problem):
        with self.condition:
            if problem in self.cleanup_problems:
                return
            self.cleanup_problems.append(problem)
        print(f"Push diagnostics cleanup failed: {problem}", file=sys.stderr, flush=True)

    def _cleanup_report(self, problems):
        for problem in problems:
            self._cleanup_problem(problem)

    def _stop_tree(self, tree):
        try:
            for problem in tree.stop() or ():
                self._cleanup_problem(problem)
        except Exception as exc:
            self._cleanup_problem(str(exc))

    def invalidate(self):
        with self.condition:
            self.generation += 1

    def submit(self, workspace, configuration):
        with self.condition:
            if self.closed:
                return
            self.generation += 1
            self.pending = (self.generation, list(workspace.roots), configuration, dict(workspace.documents))
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, name="lsp-diagnostics", daemon=True)
                self.thread.start()
            self.condition.notify()

    def _run(self):
        tree = None
        try:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or self.pending is not None)
                    if self.closed:
                        return
                    generation, roots, configuration, documents = self.pending
                    self.pending = None
                if tree is None:
                    # Match the language entrypoint before importing RF: a project
                    # robot.py or optional-library shadow must never execute.
                    bootstrap = ("import os, sys; cwd = os.getcwd(); "
                                 "sys.path[:] = [p for p in sys.path if p not in ('', '.') "
                                 "and os.path.abspath(p) != cwd]; "
                                 "import runpy; runpy.run_module(sys.argv[1], run_name='__main__')")
                    tree = ProcessTree([sys.executable, "-c", bootstrap, __name__], report=self._cleanup_report,
                                       stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=sys.stderr)
                    with self.condition:
                        if self.closed:
                            return
                        self.tree = tree
                    stream = FramedStream(tree.process.stdout, tree.process.stdin)
                # Individual document frames keep the existing protocol size bound;
                # a workspace snapshot need not fit in one protocol message.
                stream.write({"method": "snapshot", "generation": generation,
                              "roots": [str(path) for path in roots], "configuration": configuration})
                for path, (version, text) in documents.items():
                    stream.write({"method": "document", "uri": path.as_uri(), "version": version, "text": text})
                stream.write({"method": "analyse"})
                while True:
                    message = stream.read()
                    if message is None:
                        raise OSError("Push-diagnostics worker exited before completing its snapshot")
                    if message.get("method") == "complete":
                        break
                    with self.condition:
                        if not self.closed and generation == self.generation:
                            self.notify(message["method"], message["params"])
        except Exception as exc:
            with self.condition:
                if not self.closed:
                    self.notify("window/logMessage", {"type": 1, "message": f"Push diagnostics failed: {exc}"})
        finally:
            if tree is not None:
                try:
                    self._stop_tree(tree)
                    for pipe in (tree.process.stdin, tree.process.stdout):
                        try:
                            pipe.close()
                        except Exception as exc:
                            self._cleanup_problem(str(exc))
                finally:
                    try:
                        tree.close()  # release the Windows kill-on-close Job Object too
                    except Exception as exc:
                        self._cleanup_problem(str(exc))
            with self.condition:
                self.tree = None
                self.thread = None
                if not self.closed and self.pending is not None:
                    self.thread = threading.Thread(target=self._run, name="lsp-diagnostics", daemon=True)
                    self.thread.start()

    def close(self):
        with self.condition:
            self.closed = True
            self.pending = None
            tree, thread = self.tree, self.thread
            self.condition.notify()
        if tree is not None:
            try:
                self._stop_tree(tree)
            finally:
                try:
                    tree.close()
                except Exception as exc:
                    self._cleanup_problem(str(exc))
        if thread is not None:
            thread.join(timeout=5)
            if thread.is_alive():
                self._cleanup_problem("Push-diagnostics worker did not stop")
        if self.cleanup_problems:
            raise RuntimeError("Push diagnostics cleanup failed: " + "; ".join(self.cleanup_problems))


def main():
    stream = FramedStream(sys.stdin.buffer, sys.stdout.buffer)
    workspace = None
    while (message := stream.read()) is not None:
        method = message["method"]
        if method == "snapshot":
            workspace = Workspace()
            workspace.roots = [Path(path) for path in message["roots"]]
            configuration = message.get("configuration")
            workspace.config = project.parse(configuration) if configuration is not None else project.EMPTY
        elif method == "document":
            workspace.documents[uri_path(message["uri"])] = (message["version"], message["text"])
        elif method == "analyse":
            for path, (version, _) in workspace.documents.items():
                try:
                    found = workspace.to_editor(diagnostics.publishable(workspace, path.as_uri()), path.as_uri())
                    stream.write({"method": "textDocument/publishDiagnostics", "params": {
                        "uri": path.as_uri(), "version": version, "diagnostics": found}})
                except Exception as exc:
                    stream.write({"method": "window/logMessage", "params": {
                        "type": 1, "message": f"Push diagnostics failed for {path}: {exc}"}})
            stream.write({"method": "complete"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
