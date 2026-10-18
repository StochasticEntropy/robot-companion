"""Explicit service entrypoint. Launch argv directly, without a shell."""

import argparse
import importlib.metadata
import importlib.util
import json
import sys

from . import CONTRACT_VERSION, __version__


def runtime_report():
    versions = {}
    for distribution in ("robotframework", "debugpy"):
        try:
            versions[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            versions[distribution] = None
    return {
        "backend": __version__, "contractVersion": CONTRACT_VERSION,
        "python": sys.version.split()[0], "dependencies": versions,
        "robotcodePresent": importlib.util.find_spec("robotcode") is not None,
        "services": {"lsp": "definitions, limited diagnostics, hover, completion, signature help; "
                            "live suites test_lsp_live, test_lsp_features_live",
                     "dap": "phase-1 Robot pause/inspect/step/console and Python handoff v1; live suites test_dap_live, test_dap_mixed_live"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=("doctor", "lsp", "dap"))
    args = parser.parse_args()
    if args.service == "doctor":
        report = runtime_report()
        print(json.dumps(report, indent=2))
        return 0 if all(report["dependencies"].values()) and not report["robotcodePresent"] else 2
    if args.service == "dap":
        from .dap import serve
    else:
        from .lsp import serve
    return serve(sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    sys.exit(main())
