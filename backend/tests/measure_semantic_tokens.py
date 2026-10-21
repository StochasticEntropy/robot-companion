"""Semantic token delta measurement on a generated synthetic workspace (real processes).

    python measure_semantic_tokens.py [--files 160] [--cases 40] [--report report.json]

One service process answers whole results and deltas while every document is edited
(insertion, deletion, Unicode, import removal, no change) over several rounds; an oracle
process that never serves deltas answers whole results for the same text. Each delta,
applied to the previous result, must equal the oracle's result, and IDs of evicted
documents must get whole results. Reported: request times, payload sizes, the service's
resident memory per round (Linux /proc) and the kept-result bound. Exits 1 on any mismatch.
"""

import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time

from client import Client
from robot_companion_backend.semantic_tokens import MAX_RESULTS

LIBRARY = "def build_record(name):\n    return name\n\n\ndef ünïcode_step():\n    pass\n"
RESOURCE = "*** Keywords ***\nShared Step\n    [Arguments]    ${value}\n    Log    ${value}\n"


def suite(index, cases):
    rows = ["*** Settings ***", "Library    Lib.py", "Resource    shared.resource", "",
            "*** Variables ***", f"${{NAME}}    Grüße {index} 😀", "", "*** Test Cases ***"]
    for case in range(cases):
        rows += [f"Prüfung {index}.{case} 😀", f"    ${{record}}=    Build Record    name=${{NAME}}",
                 f"    Shared Step    ${{record}}", f"    Local Step {case % 3}", "    FOR    ${i}    IN RANGE    2",
                 "        Log    ${i} 𝔘", "    END", ""]
    rows += ["*** Keywords ***"] + [f"Local Step {k}\n    Log    {k}" for k in range(3)]
    return "\n".join(rows) + "\n"


EDITS = [
    ("insert a line", lambda text: text.replace("    Shared Step    ${record}\n",
                                                "    Shared Step    ${record}\n    Log    neu 😀 ${NAME}\n", 1)),
    ("delete lines", lambda text: text.replace("    FOR    ${i}    IN RANGE    2\n        Log    ${i} 𝔘\n    END\n", "", 1)),
    ("unicode before tokens", lambda text: text.replace("Shared Step    ${record}", "Shared Step    Äö😀𝔘 ${record}", 1)),
    ("remove an import", lambda text: text.replace("Library    Lib.py\n", "", 1)),
    ("restore the import", lambda text: text if "Library    Lib.py" in text else
     text.replace("*** Settings ***\n", "*** Settings ***\nLibrary    Lib.py\n", 1)),
    ("no change", lambda text: text),
]


def rss_kib(pid):
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        pass
    return None


def apply_edits(data, edits):
    result, position = [], 0
    for edit in edits:
        if edit["start"] < position or edit["start"] + edit["deleteCount"] > len(data):
            raise ValueError(f"invalid edit {edit['start']}+{edit['deleteCount']}")
        result += data[position:edit["start"]] + edit.get("data", [])
        position = edit["start"] + edit["deleteCount"]
    return result + data[position:]


def summary(values):
    values = sorted(values)
    return {"count": len(values), "median": round(statistics.median(values), 3) if values else None,
            "p95": round(values[int(0.95 * (len(values) - 1))], 3) if values else None,
            "max": round(values[-1], 3) if values else None, "total": round(sum(values), 3)}


def start(root):
    client = Client()
    client.request("initialize", {"rootUri": root.as_uri(), "capabilities": {}})
    client.send("initialized", {})
    return client


def stop(client):
    try:
        client.request("shutdown")
        client.send("exit")
        client.process.wait(timeout=10)
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--files", type=int, default=160)
    parser.add_argument("--cases", type=int, default=20)
    parser.add_argument("--open", type=int, default=2, help="documents open in the editor (the last ones)")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--report")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="rcb-semantic-measure-") as directory:
        root = Path(directory)
        (root / "Lib.py").write_text(LIBRARY, encoding="utf-8")
        (root / "shared.resource").write_text(RESOURCE, encoding="utf-8")
        texts, paths = {}, {}
        for index in range(args.files):
            path = root / f"suite_{index:04}.robot"
            paths[path.as_uri()], texts[path.as_uri()] = path, suite(index, args.cases)
            path.write_text(texts[path.as_uri()], encoding="utf-8")
        opened = set(list(texts)[-args.open:]) if args.open else set()
        service, oracle = start(root), start(root)
        report = {"files": args.files, "casesPerFile": args.cases, "openDocuments": len(opened),
                  "lines": sum(t.count("\n") for t in texts.values()), "maxResults": MAX_RESULTS,
                  "rounds": [], "mismatches": [], "python": sys.version.split()[0]}
        versions = dict.fromkeys(texts, 1)

        def change(uri, text):
            """An open document changes in the editor; any other file changes on disk."""
            texts[uri] = text
            versions[uri] += 1
            if uri not in opened:
                paths[uri].write_text(text, encoding="utf-8")
            for client in (service, oracle):
                if uri in opened:
                    client.send("textDocument/didChange", {"textDocument": {"uri": uri, "version": versions[uri]},
                                                           "contentChanges": [{"text": text}]})
                else:
                    client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": uri, "type": 2}]})

        def settled():
            """Both processes have handled every earlier notification (and their diagnostics):
            an unknown method is answered at once, in order."""
            for client in (service, oracle):
                try:
                    client.request("robotCompanion/measureSync", {})
                except AssertionError as refused:
                    assert refused.args[0]["error"]["code"] == -32601, refused

        def timed(client, method, params):
            began = time.perf_counter()
            result = client.request(method, params)
            return result, (time.perf_counter() - began) * 1000

        try:
            for uri in opened:
                for client in (service, oracle):
                    client.send("textDocument/didOpen", {"textDocument": {
                        "uri": uri, "languageId": "robotframework", "version": 1, "text": texts[uri]}})
            last, full_times, full_sizes = {}, [], []
            for uri in texts:
                result, ms = timed(service, "textDocument/semanticTokens/full", {"textDocument": {"uri": uri}})
                full_times.append(ms)
                full_sizes.append(len(json.dumps(result)))
                last[uri] = result
            report["initialFull"] = {"ms": summary(full_times), "bytes": summary(full_sizes),
                                     "tokens": summary([len(r["data"]) // 5 for r in last.values()]),
                                     "rssKiB": rss_kib(service.process.pid)}
            for number in range(1, args.rounds + 1):
                delta_times, whole_times, delta_sizes, whole_sizes = [], [], [], []
                kinds = {"edits": 0, "data": 0}
                for uri in texts:
                    for name, edit in EDITS:
                        change(uri, edit(texts[uri]))
                        settled()
                        result, ms = timed(service, "textDocument/semanticTokens/full/delta", {
                            "textDocument": {"uri": uri}, "previousResultId": last[uri]["resultId"]})
                        expected, whole_ms = timed(oracle, "textDocument/semanticTokens/full", {"textDocument": {"uri": uri}})
                        delta_times.append(ms)
                        whole_times.append(whole_ms)
                        kinds["edits" if "edits" in result else "data"] += 1
                        data = apply_edits(last[uri]["data"], result["edits"]) if "edits" in result else result["data"]
                        delta_sizes.append(len(json.dumps(result)))
                        whole_sizes.append(len(json.dumps(expected)))
                        if data != expected["data"]:
                            report["mismatches"].append({"round": number, "uri": uri, "edit": name})
                        last[uri] = {"resultId": result["resultId"], "data": data}
                # Every document was answered in this round, so only the last MAX_RESULTS are kept:
                # the first document's last ID (evicted when there are more files) gets a whole result.
                first = next(iter(texts))
                evicted = service.request("textDocument/semanticTokens/full/delta", {
                    "textDocument": {"uri": first}, "previousResultId": last[first]["resultId"]})
                data = evicted["data"] if "data" in evicted else apply_edits(last[first]["data"], evicted["edits"])
                if data != oracle.request("textDocument/semanticTokens/full", {"textDocument": {"uri": first}})["data"]:
                    report["mismatches"].append({"round": number, "uri": first, "edit": "after eviction"})
                if ("data" in evicted) != (args.files > MAX_RESULTS):
                    report["mismatches"].append({"round": number, "uri": first, "edit": "eviction bound not applied"})
                last[first] = {"resultId": evicted["resultId"], "data": data}
                report["rounds"].append({
                    "round": number, "deltaRequests": len(delta_times), "answers": kinds,
                    "deltaMs": summary(delta_times), "wholeMsSameStateOracle": summary(whole_times),
                    "deltaBytes": summary(delta_sizes), "wholeBytesSameState": summary(whole_sizes),
                    "firstDocumentAfterRound": "whole result (evicted)" if "data" in evicted else "edits (kept)",
                    "rssKiB": rss_kib(service.process.pid)})
            kept = max(len(r["data"]) for r in last.values())
            report["keptBound"] = {"documents": min(args.files, MAX_RESULTS), "largestResultInts": kept,
                                   "boundBytes": min(args.files, MAX_RESULTS) * kept * 4}
        finally:
            stop(service)
            stop(oracle)
    text = json.dumps(report, indent=2)
    if args.report:
        Path(args.report).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 1 if report["mismatches"] else 0


if __name__ == "__main__":
    sys.exit(main())
