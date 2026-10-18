"""Offline standalone build/install and headless conformance, outside the checkout."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

from release_runner import Runner, safe_environment

SUITES = ('test_transport.py', 'test_dap_lifecycle.py', 'test_release_harness.py',
          'test_lsp_live.py', 'test_dap_live.py', 'test_dap_mixed_live.py')
LIVE = frozenset(('test_lsp_live.py', 'test_dap_live.py', 'test_dap_mixed_live.py'))
ROOT = Path(__file__).resolve().parents[2]
PROBE = '''import importlib.metadata as m, importlib.util as u, json, sys
import robot_companion_backend as backend
print(json.dumps({"python": sys.version, "prefix": sys.prefix, "backendFile": backend.__file__,
 "robotcodePresent": u.find_spec("robotcode") is not None,
 "distributions": sorted((d.metadata["Name"], d.version) for d in m.distributions())}))
'''


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2))


def suite_result(result, required_live=False):
    counts = {'run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'skipped': len(result.skipped), 'expectedFailures': len(result.expectedFailures),
              'unexpectedSuccesses': len(result.unexpectedSuccesses)}
    counts['passed'] = result.wasSuccessful() and result.testsRun > 0 and not result.expectedFailures \
        and (not required_live or not result.skipped)
    counts['passedTests'] = result.testsRun - sum(counts[key] for key in ('failures', 'errors', 'skipped', 'expectedFailures'))
    # Class/module setup errors can occur before testsRun is incremented.
    counts['passedTests'] = max(0, counts['passedTests'])
    return counts


def run_suite(pattern, receipt):
    if pattern not in SUITES:
        raise ValueError('Unknown conformance suite')
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'backend/tests'), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    counts = suite_result(result, pattern in LIVE)
    write_json(receipt, {'mode': 'single-suite; not standalone release proof', 'suite': pattern, **counts})
    return 0 if counts['passed'] else 1


def outside_checkout(path):
    return path != ROOT and ROOT not in path.parents


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheels', type=Path)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--scratch-root', type=Path, default=Path('/tmp'))
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
    report = {'mode': 'standalone release', 'outcome': 'Blocked', 'checks': []}
    report_path = evidence / 'release.json'
    write_json(report_path, report)
    try:
        sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, text=True)
        report.update(sourceSha=sha, dirtyBefore=dirty, python=sys.version)
        if dirty:
            raise ValueError('Release verification requires a clean committed artifact')
        if sys.version_info[:2] != (3, 13):
            raise ValueError('Release verification requires Python 3.13')
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
        archive = subprocess.check_output(['git', 'archive', sha, 'backend'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(work, filter='data')
        (work / 'node_modules').mkdir()
        report['frontendDependencies'] = 'empty node_modules; no extension files copied'
        backend = work / 'backend'
        venv = work / 'venv'
        python = venv / 'bin/python'
        env = safe_environment()
        env['RCB_TRANSCRIPTS'] = str(evidence / 'protocol')
        with Runner(evidence) as runner:
            def step(name, command):
                receipt = runner.run(name, [str(a) for a in command], work, env)
                report['checks'].append(receipt)
                write_json(report_path, report)
                if not receipt['passed']:
                    raise RuntimeError(f'{name} failed; see retained receipt')
                return receipt
            step('venv', [sys.executable, '-m', 'venv', venv])
            step('build-tools', [python, '-m', 'pip', 'install', '--no-index', '--find-links', wheels,
                 '-c', backend / 'constraints.txt', '--report', evidence / 'build-tools-install.json',
                 'build', 'setuptools', 'wheel'])
            step('build', [python, '-m', 'build', '--no-isolation', '--outdir', work / 'dist', backend])
            built_wheels = list((work / 'dist').glob('*.whl'))
            if len(built_wheels) != 1 or len(list((work / 'dist').glob('*.tar.gz'))) != 1:
                raise RuntimeError('Expected exactly one backend wheel and one sdist')
            step('install', [python, '-m', 'pip', 'install', '--no-index', '--find-links', wheels,
                 '-c', backend / 'constraints.txt', '--report', evidence / 'backend-install.json', built_wheels[0]])
            step('installed-probe', [python, '-I', '-c', PROBE])
            probe = json.loads((evidence / 'installed-probe.txt').read_text())
            report['installed'] = probe
            if probe['robotcodePresent'] or not Path(probe['backendFile']).is_relative_to(venv) \
                    or Path(probe['prefix']) != venv:
                raise RuntimeError('Installed probe is not the independent backend virtual environment')
            if any(name.lower().replace('_', '-') == 'robot-markdown-companion' for name, _ in probe['distributions']):
                raise RuntimeError('Companion must be absent from the backend virtual environment')
            step('doctor', [venv / 'bin/robot-companion-backend', 'doctor'])
            # After install, run all suites even if one fails. Each has its own
            # bounded subprocess and structured count receipt; never borrow passes.
            failed = False
            for pattern in SUITES:
                name = pattern.removesuffix('.py')
                receipt_path = evidence / (name + '-counts.json')
                receipt = runner.run(name, [str(python), str(backend / 'scripts/verify_release.py'),
                    '--run-suite', pattern, '--receipt', str(receipt_path)], work, env)
                if receipt_path.is_file():
                    receipt['counts'] = json.loads(receipt_path.read_text())
                report['checks'].append(receipt)
                failed |= not receipt['passed'] or not receipt.get('counts', {}).get('passed', False)
                write_json(report_path, report)
            report['outcome'] = 'Fail' if failed else 'Pass'
        dist = evidence / 'dist'
        shutil.copytree(work / 'dist', dist)
        report['builtArtifacts'] = [{'name': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                    for p in sorted(dist.iterdir()) if p.is_file()]
        if list((work / 'node_modules').iterdir()):
            raise RuntimeError('Frontend dependency directory was modified')
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError, tarfile.TarError) as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        if report['checks']:
            report['outcome'] = 'Fail'
    finally:
        try:
            report['dirtyAfter'] = subprocess.check_output(
                ['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, text=True)
            report['sourceShaAfter'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            if report['dirtyAfter'] or report.get('sourceSha') != report['sourceShaAfter']:
                report['outcome'] = 'Fail'
        except (OSError, subprocess.SubprocessError) as exc:
            report.update(outcome='Fail', sourceStateError=str(exc))
        write_json(report_path, report)
    print(json.dumps({'outcome': report['outcome'], 'sourceSha': report.get('sourceSha'),
                      'report': str(report_path), 'error': report.get('error')}))
    return 0 if report['outcome'] == 'Pass' else 2 if report['outcome'] == 'Blocked' else 1


if __name__ == '__main__':
    sys.exit(main())
