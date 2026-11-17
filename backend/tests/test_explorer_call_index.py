"""The keyword listing's bounded candidates must preserve shared resolver semantics."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from robot_companion_backend.explorer import CallIndex
from robot_companion_backend.workspace import Workspace


class ExplorerIndexTests(unittest.TestCase):
    def test_candidate_groups_resolve_like_the_full_graph(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "Steps.py").write_text("def report(): pass\ndef check_value(): pass\n")
            path = root / "suite.robot"
            workspace = Workspace()
            workspace.roots = [root]
            workspace.open(path.as_uri(), "*** Settings ***\nLibrary    Steps.py    AS    A.B\n"
                           "Library    Steps.py    AS    Other\n*** Keywords ***\n"
                           "Read ${name}\n    No Operation\nLiteral.With.Dot\n    No Operation\n", 1)
            with workspace.source_snapshot():
                graph = workspace.graph(path)
                index = CallIndex(graph)
                for text in ("Report", "A.B.Report", "given A.B.report", "Other.Check Value",
                             "Read data", "When read data", "literal.with.dot", "No Operation", "Unknown"):
                    with self.subTest(text=text):
                        candidates = list(index.candidates(text))
                        self.assertLess(sum(map(len, candidates)), 10)
                        self.assertEqual(workspace.resolve_call(candidates, text),
                                         workspace.resolve_call(graph.groups, text))
