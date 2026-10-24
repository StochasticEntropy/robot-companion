"""Offline standalone build/install and headless conformance, outside the checkout."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

from release_runner import WINDOWS, Runner, safe_environment

SUITES = ('test_transport.py', 'test_dap_lifecycle.py', 'test_process_tree.py', 'test_release_harness.py',
          'test_lsp_live.py', 'test_lsp_passive_actions.py', 'test_lsp_cancellation.py', 'test_inlay_range_work.py', 'test_lsp_features_live.py', 'test_lsp_navigation_live.py', 'test_lsp_source_cache.py', 'test_navigation_backend_latency.py', 'test_source_declaration_latency.py', 'test_python_argument_clones.py', 'test_location_only_definition.py', 'test_navigation_path_resolution.py', 'test_source_expression_latency.py', 'test_declaration_target_filter.py', 'test_definition_target_filter.py', 'test_named_argument_completion.py', 'test_lsp_source_declarations_live.py', 'test_lsp_diagnostics_live.py',
          'test_lsp_libraries_live.py', 'test_lsp_explorer_live.py',
          'test_lsp_semantic_tokens_live.py', 'test_lsp_inlay_hints_live.py', 'test_windows_preview.py', 'test_discovery_live.py', 'test_discovery_parse_reuse.py', 'test_discovery_batches.py', 'test_dap_live.py', 'test_dap_conditional_live.py', 'test_dap_controls_live.py', 'test_dap_process_live.py',
          'test_dap_mixed_live.py', 'test_project_configuration_live.py', 'test_interactive_live.py', 'test_dap_advanced.py', 'test_dap_advanced_live.py', 'test_prepared.py', 'test_dap_restart_live.py', 'test_dap_prepared_live.py', 'test_project_files_live.py')
# Required suites: any skipped test fails them.
LIVE = frozenset(('test_process_tree.py', 'test_lsp_live.py', 'test_lsp_passive_actions.py', 'test_lsp_cancellation.py', 'test_inlay_range_work.py', 'test_lsp_features_live.py',
                  'test_lsp_navigation_live.py', 'test_lsp_source_cache.py', 'test_navigation_backend_latency.py', 'test_source_declaration_latency.py', 'test_python_argument_clones.py', 'test_location_only_definition.py', 'test_navigation_path_resolution.py', 'test_source_expression_latency.py', 'test_declaration_target_filter.py', 'test_definition_target_filter.py', 'test_named_argument_completion.py', 'test_lsp_source_declarations_live.py', 'test_lsp_diagnostics_live.py', 'test_lsp_libraries_live.py', 'test_lsp_explorer_live.py',
                  'test_lsp_semantic_tokens_live.py', 'test_lsp_inlay_hints_live.py', 'test_windows_preview.py', 'test_discovery_live.py', 'test_discovery_parse_reuse.py', 'test_discovery_batches.py',
                  'test_dap_live.py', 'test_dap_conditional_live.py', 'test_dap_controls_live.py', 'test_dap_process_live.py',
                  'test_dap_mixed_live.py', 'test_project_configuration_live.py', 'test_interactive_live.py', 'test_dap_advanced.py', 'test_dap_advanced_live.py', 'test_prepared.py', 'test_dap_restart_live.py',
                  'test_dap_prepared_live.py', 'test_project_files_live.py'))
FORMATTER = ('robotframework-robocop', '9.1.0')  # the optional `format` extra, required for acceptance
ROOT = Path(__file__).resolve().parents[2]
PROBE = '''import importlib.metadata as m, importlib.util as u, json, sys
import robot_companion_backend as backend
print(json.dumps({"python": sys.version, "prefix": sys.prefix, "backendFile": backend.__file__,
 "robotcodePresent": u.find_spec("robotcode") is not None,
 "distributions": sorted((d.metadata["Name"], d.version) for d in m.distributions())}))
'''


def write_json(path, data):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(path)


class ReceiptResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.successful_tests = 0

    def addSuccess(self, test):
        self.successful_tests += 1
        super().addSuccess(test)


def suite_result(result, required_live=False):
    counts = {'run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'skipped': len(result.skipped), 'expectedFailures': len(result.expectedFailures),
              'unexpectedSuccesses': len(result.unexpectedSuccesses), 'passedTests': result.successful_tests}
    counts['passed'] = result.wasSuccessful() and result.testsRun > 0 and not result.expectedFailures \
        and (not required_live or not result.skipped)
    return counts


def run_suite(pattern, receipt):
    if pattern not in SUITES:
        raise ValueError('Unknown conformance suite')
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'backend/tests'), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2, resultclass=ReceiptResult).run(suite)
    counts = suite_result(result, pattern in LIVE)
    write_json(receipt, {'mode': 'single-suite; not standalone release proof', 'suite': pattern, **counts})
    return 0 if counts['passed'] else 1


def outside_checkout(path):
    return path != ROOT and ROOT not in path.parents


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheels', type=Path)
    # The runtime row: the interpreter of the backend virtual environment (default: this one).
    # It must be a Python minor version of a supported row (robot_companion_backend.runtime).
    parser.add_argument('--python', type=Path, default=Path(sys.executable))
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--scratch-root', type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument('--run-suite', choices=SUITES, help=argparse.SUPPRESS)
    parser.add_argument('--receipt', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.run_suite:
        if args.receipt is None:
            parser.error('--run-suite requires --receipt')
        return run_suite(args.run_suite, args.receipt)
    if args.evidence is None or args.wheels is None:
        parser.error('--evidence and --wheels are required')
    evidence = args.evidence.resolve()
    scratch_root = args.scratch_root.resolve()
    wheels = args.wheels.resolve()
    if not outside_checkout(evidence) or not outside_checkout(scratch_root):
        parser.error('evidence and scratch root must be outside the checkout')
    # Never overwrite an earlier evidence batch.
    evidence.mkdir(parents=True, exist_ok=False)
    report = {'mode': 'standalone release', 'outcome': 'Blocked', 'checks': [], 'sourceChecks': []}
    completed = False
    report_path = evidence / 'release.json'
    write_json(report_path, report)
    def source_git(name, arguments, binary=False):
        # Keep the existing source-read authorization without forwarding it to
        # build/tests. Git/fsmonitor descendants also get bounded owned cleanup.
        with Runner(evidence, timeout=30) as source_runner:
            receipt = source_runner.run(name, ['git', *arguments], ROOT, os.environ.copy(), separate_stdout=True)
        report['sourceChecks'].append(receipt)
        write_json(report_path, report)
        if not receipt['passed']:
            raise RuntimeError(f'{name} failed; see retained source-command receipt')
        data = Path(receipt['stdout']).read_bytes()
        return data if binary else data.decode()
    try:
        sha = source_git('source-head', ['rev-parse', 'HEAD']).strip()
        dirty = source_git('source-status-before', ['status', '--porcelain', '--untracked-files=all'])
        report.update(sourceSha=sha, dirtyBefore=dirty, harnessPython=sys.version, requestedPython=str(args.python))
        if dirty:
            raise ValueError('Release verification requires a clean committed artifact')
        if not args.python.is_file() or not os.access(args.python, os.X_OK):
            raise ValueError('The requested runtime-row interpreter is not an executable file')
        if not wheels.is_dir() or not list(wheels.glob('*.whl')):
            raise ValueError('Approved local wheel directory is unavailable or contains no wheels')
        if not scratch_root.is_dir():
            raise ValueError('Scratch root must already exist')
        report['wheelInputs'] = [{'name': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                 for p in sorted(wheels.glob('*.whl'))]
        work = Path(tempfile.mkdtemp(prefix='rcb-release-', dir=scratch_root))
        report['work'] = str(work)
        # Build exactly the committed backend, with no extension or frontend
        # dependency tree. Extract only Git's archive using the safe data filter.
        archive = source_git('source-archive', ['archive', sha, 'backend'], binary=True)
        report['sourceArchiveSha256'] = hashlib.sha256(archive).hexdigest()
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(work, filter='data')
        (work / 'node_modules').mkdir()
        report['frontendDependencies'] = 'empty node_modules; no extension files copied'
        backend = work / 'backend'
        # The supported rows of exactly the committed source, not of the harness checkout.
        supported = runpy.run_path(str(backend / 'src/robot_companion_backend/runtime.py'))['SUPPORTED']
        report['supportedRows'] = [{'python': '%d.%d' % python, 'robotframework': robot} for python, robot in supported]
        venv = work / 'venv'
        scripts = venv / ('Scripts' if WINDOWS else 'bin')  # Windows: launchers python.exe and *.exe scripts
        python = scripts / ('python.exe' if WINDOWS else 'python')
        epoch = source_git('source-epoch', ['show', '-s', '--format=%ct', sha]).strip()
        if not epoch.isdigit():
            raise RuntimeError('Invalid source commit timestamp')
        report['sourceDateEpoch'] = epoch
        env = safe_environment()
        env['SOURCE_DATE_EPOCH'] = epoch
        env['RCB_TRANSCRIPTS'] = str(evidence / 'protocol')
        with Runner(evidence) as runner:
            def step(name, command, separate_stdout=False):
                receipt = runner.run(name, [str(a) for a in command], work, env, separate_stdout=separate_stdout)
                report['checks'].append(receipt)
                write_json(report_path, report)
                if not receipt['passed']:
                    raise RuntimeError(f'{name} failed; see retained receipt')
                return receipt
            interpreter = step('interpreter', [args.python, '-I', '-c', 'import json, sys; print(json.dumps('
                               '{"executable": sys.executable, "version": sys.version, "minor": sys.version_info[:2]}))'],
                               separate_stdout=True)
            report['interpreter'] = json.loads(Path(interpreter['stdout']).read_text(encoding="utf-8"))
            if tuple(report['interpreter']['minor']) not in {python for python, _ in supported}:
                raise ValueError(f"Python {'.'.join(map(str, report['interpreter']['minor']))} is no supported "
                                 f"runtime row: {report['supportedRows']}")
            step('venv', [args.python, '-m', 'venv', venv])
            # The in-tree backend needs no build-tool wheels; build with the
            # minimal frontend, then let pip rebuild the wheel from the sdist.
            step('build', [python, backend / 'scripts/build_dists.py', backend, work / 'dist'])
            built_wheels = list((work / 'dist').glob('*.whl'))
            sdists = list((work / 'dist').glob('*.tar.gz'))
            if len(built_wheels) != 1 or len(sdists) != 1:
                raise RuntimeError('Expected exactly one backend wheel and one sdist')
            with tarfile.open(sdists[0]) as bundle:
                bundle.extractall(work / 'sdist', filter='data')
            unpacked = [p for p in (work / 'sdist').iterdir() if p.is_dir()]
            if len(unpacked) != 1:
                raise RuntimeError('Expected exactly one sdist project directory')
            step('sdist-wheel', [python, '-m', 'pip', 'wheel', '--no-index', '--no-deps',
                 '--wheel-dir', work / 'sdist-dist', f'./{unpacked[0].relative_to(work)}'])
            rebuilt = list((work / 'sdist-dist').glob('*.whl'))
            digests = {hashlib.sha256(p.read_bytes()).hexdigest() for p in [built_wheels[0], *rebuilt]}
            report['wheelFromSdistIdentical'] = len(rebuilt) == 1 and len(digests) == 1
            if not report['wheelFromSdistIdentical']:
                raise RuntimeError('pip wheel from the sdist differs from the built wheel')
            # With the optional `format` extra, so formatting is advertised and tested.
            step('install', [python, '-m', 'pip', 'install', '--no-index', '--find-links', wheels,
                 '-c', backend / 'constraints.txt', '--report', evidence / 'backend-install.json',
                 f'{built_wheels[0]}[format]'])
            probe_receipt = step('installed-probe', [python, '-I', '-c', PROBE], separate_stdout=True)
            probe = json.loads(Path(probe_receipt['stdout']).read_text(encoding="utf-8"))
            report['installed'] = probe
            if probe['robotcodePresent'] or not Path(probe['backendFile']).is_relative_to(venv) \
                    or Path(probe['prefix']) != venv:
                raise RuntimeError('Installed probe is not the independent backend virtual environment')
            if any(name.lower().replace('_', '-') == 'robot-markdown-companion' for name, _ in probe['distributions']):
                raise RuntimeError('Companion must be absent from the backend virtual environment')
            installed = {name.lower().replace('_', '-'): version for name, version in probe['distributions']}
            report['formatter'] = {'name': FORMATTER[0], 'version': installed.get(FORMATTER[0])}
            if installed.get(FORMATTER[0]) != FORMATTER[1]:
                raise RuntimeError('The acceptance venv must contain the Robocop 9.1.0 formatter')
            doctor = step('doctor', [scripts / ('robot-companion-backend.exe' if WINDOWS else 'robot-companion-backend'),
                                     'doctor'], separate_stdout=True)
            report['doctor'] = json.loads(Path(doctor['stdout']).read_text(encoding="utf-8"))
            report['row'] = report['doctor']['runtime']
            if not report['row']['supported'] or report['doctor']['executable'] != str(python):
                raise RuntimeError('doctor does not report a supported row of the backend virtual environment')
            # After install, run all suites even if one fails. Each has its own
            # bounded subprocess and structured count receipt; never borrow passes.
            failed = False
            for pattern in SUITES:
                name = pattern.removesuffix('.py')
                receipt_path = evidence / (name + '-counts.json')
                receipt = runner.run(name, [str(python), str(backend / 'scripts/verify_release.py'),
                    '--run-suite', pattern, '--receipt', str(receipt_path)], work, env)
                if receipt_path.is_file():
                    receipt['counts'] = json.loads(receipt_path.read_text(encoding="utf-8"))
                report['checks'].append(receipt)
                failed |= not receipt['passed'] or not receipt.get('counts', {}).get('passed', False)
                write_json(report_path, report)
            # The Robot worker ran under the installed backend's interpreter (test_dap_live records).
            records = [json.loads(p.read_text(encoding="utf-8"))
                       for p in sorted((evidence / 'protocol/worker-interpreter').glob('*.json'))]
            report['workerInterpreter'] = records
            if not records or any(r['workerArgv0'] != str(python) or r['backendExecutable'] != str(python)
                                  for r in records):
                failed = True
                report['workerInterpreterError'] = 'Worker interpreter is unproven or not the backend venv python'
            report['outcome'] = 'Fail' if failed else 'Incomplete'
        dist = evidence / 'dist'
        shutil.copytree(work / 'dist', dist)
        report['builtArtifacts'] = [{'name': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                    for p in sorted(dist.iterdir()) if p.is_file()]
        if list((work / 'node_modules').iterdir()):
            raise RuntimeError('Frontend dependency directory was modified')
        completed = not failed
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError, tarfile.TarError) as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        if report['checks'] or any(not c['passed'] for c in report['sourceChecks']):
            report['outcome'] = 'Fail'
    except (KeyboardInterrupt, SystemExit) as exc:
        report.update(outcome='Fail', error=f'Interrupted: {type(exc).__name__}')
    except Exception as exc:  # An unexpected harness error is a failure, never Blocked.
        report.update(outcome='Fail', error=f'Unexpected {type(exc).__name__}: {exc}')
    finally:
        try:
            report['dirtyAfter'] = source_git('source-status-after', ['status', '--porcelain', '--untracked-files=all'])
            report['sourceShaAfter'] = source_git('source-head-after', ['rev-parse', 'HEAD']).strip()
            if report['dirtyAfter'] or report.get('sourceSha') != report['sourceShaAfter']:
                report['outcome'] = 'Fail'
        except (OSError, RuntimeError, KeyboardInterrupt, SystemExit) as exc:
            report.update(outcome='Fail', sourceStateError=f'{type(exc).__name__}: {exc}')
        report['installReports'] = [{'name': name, 'sha256': hashlib.sha256((evidence / name).read_bytes()).hexdigest()}
            for name in ('backend-install.json',) if (evidence / name).is_file()]
        # Publish Pass only after artifact retention, clean-source readback and
        # all final receipts completed normally. Earlier writes stay incomplete.
        if completed and report['outcome'] == 'Incomplete' and 'error' not in report and 'sourceStateError' not in report:
            report['outcome'] = 'Pass'
        write_json(report_path, report)
    print(json.dumps({'outcome': report['outcome'], 'sourceSha': report.get('sourceSha'),
                      'report': str(report_path), 'error': report.get('error')}))
    return 0 if report['outcome'] == 'Pass' else 2 if report['outcome'] == 'Blocked' else 1


if __name__ == '__main__':
    sys.exit(main())
