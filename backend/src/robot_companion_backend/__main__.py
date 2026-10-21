"""Explicit service entrypoint. Launch argv directly, without a shell."""

import argparse
import importlib.metadata
import importlib.util
import json
import os
import sys

from . import CONTRACT_VERSION, __version__


def runtime_report():
    from .formatting import available as formatter_version
    from .runtime import row
    versions = {}
    for distribution in ("robotframework", "debugpy"):
        try:
            versions[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            versions[distribution] = None
    return {
        "backend": __version__, "contractVersion": CONTRACT_VERSION,
        "python": sys.version.split()[0], "executable": sys.executable, "dependencies": versions,
        # This interpreter's Python/RF combination and the supported matrix (runtime.SUPPORTED).
        "runtime": row(),
        "robotcodePresent": importlib.util.find_spec("robotcode") is not None,
        # Optional: textDocument/formatting is advertised only with Robocop 9.1.0 installed.
        "formatter": {"robocop": formatter_version()},
        "services": {"lsp": "definitions, diagnostics, quick fixes, formatting (with Robocop), hover, completion, "
                            "signature help, references, rename, document/workspace symbols, semantic tokens "
                            "(full, range); live suites test_lsp_live, test_lsp_features_live, "
                            "test_lsp_navigation_live, test_lsp_diagnostics_live, test_lsp_semantic_tokens_live",
                     "discovery": "normalized discovery API v1 (robotCompanion/discoverTests); "
                                  "live suite test_discovery_live",
                     "dap": "phase-1 Robot pause/inspect/step/console and Python handoff v1; live suites test_dap_live, "
                            "test_dap_conditional_live, test_dap_process_live, test_dap_mixed_live, "
                            "test_dap_advanced_live"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=("doctor", "lsp", "dap", "discovery"))
    args = parser.parse_args()
    if args.service == "doctor":
        report = runtime_report()
        print(json.dumps(report, indent=2))
        return 0 if all(report["dependencies"].values()) and report["runtime"]["supported"] \
            and not report["robotcodePresent"] else 2
    if args.service == "dap":
        from .dap import serve
    else:
        # `python -m` puts the cwd (often the workspace) first on sys.path; the language and
        # discovery services import only RF and the standard library, never a workspace module.
        cwd = os.getcwd()
        sys.path[:] = [entry for entry in sys.path if entry not in ("", ".") and os.path.abspath(entry) != cwd]
        if args.service == "discovery":
            from .discovery import serve
        else:
            from .lsp import serve
    return serve(sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    sys.exit(main())
