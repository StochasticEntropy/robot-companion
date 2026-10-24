"""Fast RF argument clones preserve deepcopy semantics and mutable isolation."""

import copy
import inspect
from pathlib import Path
import tempfile
from typing import ForwardRef, Literal, Union
import unittest
from unittest import mock

from robot.running.arguments import ArgumentSpec
from robot.running.arguments.typeinfo import TypeInfo
from robot_companion_backend import workspace as workspace_module
from robot_companion_backend.workspace import Workspace


class SpecializedTypeInfo(TypeInfo):
    def __init__(self):
        super().__init__("Specialized", str)
        self.extra = {"items": [1]}


class SpecializedArguments(ArgumentSpec):
    pass


class PythonArgumentCloneTests(unittest.TestCase):
    @staticmethod
    def clone(spec):
        # The previous production path cloned each complete specification with deepcopy.
        # Keep that real behavior usable for the quantitative baseline comparison.
        return getattr(workspace_module, "clone_arguments", copy.deepcopy)(spec)

    @classmethod
    def type_fact(cls, info):
        if info is None:
            return None
        return (type(info), info.name, info.type,
                None if info.nested is None else tuple(cls.type_fact(child) for child in info.nested),
                getattr(info, "alias", None), copy.deepcopy(getattr(info, "extra", None)))

    @classmethod
    def fact(cls, spec):
        if spec is None:
            return None
        return {
            "class": type(spec), "name": spec.name, "type": spec.type,
            "positional_only": spec.positional_only, "positional_or_named": spec.positional_or_named,
            "var_positional": spec.var_positional, "named_only": spec.named_only,
            "var_named": spec.var_named, "embedded": spec.embedded,
            "defaults": copy.deepcopy(spec.defaults),
            "types": None if spec.types is None else {name: cls.type_fact(info) for name, info in spec.types.items()},
            "return_type": cls.type_fact(spec.return_type),
            "signature": tuple(str(argument) for argument in spec),
            "docs": copy.deepcopy(getattr(spec, "docs", None)),
            "return_doc": getattr(spec, "return_doc", None),
            "raises": copy.deepcopy(getattr(spec, "raises", None)),
        }

    def rich_specification(self):
        extras = {}
        if "docs" in inspect.signature(ArgumentSpec).parameters:
            extras = {"docs": {"data": "The selected data."}, "return_doc": "The transformed result.",
                      "raises": {"ValueError": "Invalid data."}}
        return ArgumentSpec(
            name="Grüße ${embedded}", type="Keyword", positional_only=["data"],
            positional_or_named=["choice", "literal", "forward", "optional"],
            var_positional="rest", named_only=["mode"], var_named="options", embedded=["embedded"],
            defaults={"optional": {"values": [1, {"nested": [2]}]}, "mode": "safe"},
            types={"data": list[dict[str, tuple[int, ...]]], "choice": Union[int, str, None],
                   "literal": Literal["safe", 7, False], "forward": ForwardRef("ExampleItem"),
                   "optional": list[str], "rest": tuple[int, ...], "mode": str, "options": dict[str, int]},
            return_type=dict[str, list[int | None]], **extras)

    def test_none_rich_types_and_invalid_annotations_match_deepcopy_projection(self):
        self.assertIsNone(self.clone(None))
        prototypes = [self.rich_specification(), ArgumentSpec("Empty"),
                      workspace_module.argument_spec("Invalid hint", positional_or_named=["value", "bad"],
                          defaults={"bad": None}, types={"value": "list[int]", "bad": "list["},
                          return_type="list[")]
        for prototype in prototypes:
            with self.subTest(name=prototype.name):
                expected = copy.deepcopy(prototype)
                cloned = self.clone(prototype)
                self.assertEqual(self.fact(cloned), self.fact(expected))
                self.assertIsNot(cloned, prototype)
                self.assertIsNot(cloned.defaults, prototype.defaults)
                if prototype.types is not None:
                    self.assertIsNot(cloned.types, prototype.types)
        self.assertNotIn("bad", prototypes[-1].types)

    def test_nested_type_nodes_and_mutable_defaults_are_isolated_between_all_clones(self):
        prototype = self.rich_specification()
        expected = self.fact(copy.deepcopy(prototype))
        first, second = self.clone(prototype), self.clone(prototype)
        self.assertIsNot(first.types["data"], prototype.types["data"])
        self.assertIsNot(first.types["data"].nested[0], second.types["data"].nested[0])
        first.types["data"].nested[0].name = "ChangedDictionary"
        first.types["data"].nested = (TypeInfo("Replacement", str),)
        first.return_type.nested[1].nested[0].name = "ChangedReturn"
        first.defaults["optional"]["values"][1]["nested"].append(99)
        first.defaults["mode"] = "changed"
        self.assertEqual(self.fact(prototype), expected)
        self.assertEqual(self.fact(second), expected)
        third = self.clone(prototype)
        self.assertEqual(self.fact(third), expected)

    def test_public_alias_docs_and_raises_metadata_are_preserved_and_independent(self):
        prototype = self.rich_specification()
        if hasattr(TypeInfo("Probe"), "alias"):
            prototype.types["data"] = TypeInfo("list", list, [TypeInfo("int", int)], alias="ExampleItems")
        clone = self.clone(prototype)
        self.assertEqual(self.fact(clone), self.fact(copy.deepcopy(prototype)))
        if hasattr(prototype.types["data"], "alias"):
            self.assertEqual(clone.types["data"].alias, "ExampleItems")
            clone.types["data"].alias = "ChangedAlias"
            self.assertEqual(prototype.types["data"].alias, "ExampleItems")
        if hasattr(prototype, "docs"):
            clone.docs["data"] = "Changed documentation."
            clone.raises["ValueError"] = "Changed exception."
            self.assertEqual(prototype.docs["data"], "The selected data.")
            self.assertEqual(prototype.raises["ValueError"], "Invalid data.")

    def test_subclasses_and_unknown_mutable_leaves_use_general_copy_fallback(self):
        specialized = SpecializedTypeInfo()
        mutable = TypeInfo("Mutable", {"items": [1]})
        prototype = ArgumentSpec("Fallback", positional_or_named=["special", "mutable"],
                                 types={"special": specialized, "mutable": mutable})
        original_deepcopy = copy.deepcopy
        with mock.patch.object(workspace_module.copy, "deepcopy", wraps=original_deepcopy) as copied:
            cloned = self.clone(prototype)
        copied_values = [call.args[0] for call in copied.call_args_list]
        self.assertTrue(any(value is specialized for value in copied_values))
        self.assertTrue(any(value is mutable for value in copied_values))
        self.assertIs(type(cloned.types["special"]), SpecializedTypeInfo)
        self.assertEqual(self.fact(cloned), self.fact(original_deepcopy(prototype)))
        cloned.types["special"].extra["items"].append(2)
        cloned.types["mutable"].type["items"].append(2)
        self.assertEqual(specialized.extra, {"items": [1]})
        self.assertEqual(mutable.type, {"items": [1]})
        subclass = SpecializedArguments("Subclass", defaults={"value": {"items": [1]}})
        subclass.extra = {"items": [2]}
        child = self.clone(subclass)
        self.assertIs(type(child), SpecializedArguments)
        child.extra["items"].append(3)
        self.assertEqual(subclass.extra, {"items": [2]})

    def test_normal_rich_clone_does_not_deepcopy_argument_or_plain_type_graphs(self):
        prototype = self.rich_specification()
        expected = self.fact(copy.deepcopy(prototype))
        original_deepcopy = copy.deepcopy
        with mock.patch.object(workspace_module.copy, "deepcopy", wraps=original_deepcopy) as copied:
            cloned = self.clone(prototype)
        heavy = [type(call.args[0]).__name__ for call in copied.call_args_list
                 if isinstance(call.args[0], (ArgumentSpec, TypeInfo))]
        self.assertEqual(heavy, [], "Plain static type trees must use the bounded public-API clone path")
        self.assertEqual(self.fact(cloned), expected)

    def test_warm_actual_python_symbols_clone_17_rich_specs_without_generic_graph_copies(self):
        with tempfile.TemporaryDirectory(prefix="native-clones-") as directory:
            path = Path(directory) / "Library.py"
            source = ("from robot.api.deco import keyword\nfrom typing import Literal\n"
                      "raise RuntimeError('Never import workspace code')\n\nclass Library:\n" + "".join(
                f"    @keyword('Probe {index:02}')\n"
                f"    def probe_{index}(self, data: list[dict[str, tuple[int, ...]]], choice: int | str | None, "
                "mode: Literal['safe', 'fast'] = 'safe') -> dict[str, list[int | None]]:\n"
                "        return {}\n\n" for index in range(17)))
            path.write_text(source, encoding="utf-8")
            workspace = Workspace()
            first = workspace.python_symbols(path, "First")
            self.assertEqual(len(first), 17)
            original_deepcopy = copy.deepcopy
            with mock.patch.object(workspace_module.copy, "deepcopy", wraps=original_deepcopy) as copied:
                with mock.patch.object(workspace_module, "python_arguments", wraps=workspace_module.python_arguments) as arguments:
                    second = workspace.python_symbols(path, "Second")
                self.assertEqual(arguments.call_count, 0)
            heavy = [type(call.args[0]).__name__ for call in copied.call_args_list
                     if isinstance(call.args[0], (ArgumentSpec, TypeInfo))]
            self.assertEqual(heavy, [], "Warm symbol cloning must not traverse RF graphs with generic deepcopy")
            self.assertEqual([symbol.namespace for symbol in second], ["Second"] * 17)
            self.assertEqual([self.fact(symbol.args) for symbol in first], [self.fact(symbol.args) for symbol in second])
            second[0].args.types["data"].nested[0].name = "Changed"
            self.assertNotEqual(first[0].args.types["data"].nested[0].name, "Changed")


if __name__ == "__main__":
    unittest.main()
