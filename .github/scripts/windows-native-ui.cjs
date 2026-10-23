const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { vscodeRuntimeManifest } = require('./windows-ui-smoke.cjs');
const COMMIT = '2a59476c9bfcb90b3ddc372c36762471b7dfad1c';

function requiredVerdict(result, counts, backend, suite) {
  assert.equal(suite, 'native-libraries');
  assert.equal(result.required, true);
  assert.equal(result.suite, suite);
  assert.equal(result.grep || '', '');
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.notEqual(backend.available, false);
  assert.equal(backend.doctor?.robotcodePresent, false);
  assert.equal(backend.formatter, 'robotframework-robocop==9.1.0');
  assert.equal(backend.robotCodeInVenv, false);
  assert(counts && counts.totals && typeof counts.suites === 'object');
  const entries = Object.values(counts.suites);
  assert(entries.length > 0);
  for (const item of [...entries, counts.totals]) {
    for (const key of ['passes', 'failures', 'pending', 'total']) assert(Number.isSafeInteger(item[key]) && item[key] >= 0);
    assert(item.total > 0);
    assert.equal(item.failures, 0);
    assert.equal(item.pending, 0);
    assert.equal(item.passes, item.total);
  }
  for (const key of ['passes', 'failures', 'pending', 'total']) {
    assert.equal(entries.reduce((sum, item) => sum + item[key], 0), counts.totals[key]);
  }
  return counts.totals;
}

const SHOTS = ['f12-run-keyword', 'f12-class-override', 'f12-dynamic', 'hover-run-keyword-if', 'references-run-keyword', 'unsaved-library-edit', 'unsaved-library-diagnostic', 'unsaved-library-completion', 'completion-run-keyword'];
function requiredScreenshots(directory) {
  return SHOTS.map(name => {
    const filename = `native-libraries-${name}.png`, target = path.join(directory, filename);
    const stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size >= 8 && stat.size <= 5 * 1024 * 1024);
    assert.equal(fs.readFileSync(target).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    return filename;
  });
}

async function main(argv) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const [source, evidence, scratch] = argv.map(item => path.resolve(item));
  assert(source && evidence && scratch);
  fs.mkdirSync(evidence, { recursive: true });
  const suite = 'native-libraries';
  const declared = require(path.join(source, 'tests/ui/suite/suites.js'));
  assert(Object.hasOwn(declared.SUITES, suite), 'candidate must declare the exact suite');
  const electron = require(path.join(source, 'node_modules/@vscode/test-electron'));
  const executable = await electron.downloadAndUnzipVSCode({ version: '1.141.0', platform: 'win32-x64-archive', cachePath: path.join(scratch, 'vscode'), timeout: 60000 });
  const runtime = vscodeRuntimeManifest(executable);
  assert.equal(runtime.vscodeCommit, COMMIT, 'actual VS Code commit must be pinned');
  fs.writeFileSync(path.join(evidence, 'vscode-runtime.json'), JSON.stringify(runtime, null, 2));
  const env = { ...process.env, ROBOT_COMPANION_VSCODE_EXECUTABLE: runtime.executablePath,
    ROBOT_COMPANION_UI_SUITE: suite, ROBOT_COMPANION_UI_REQUIRE_NATIVE: '1',
    ROBOT_COMPANION_UI_EVIDENCE_DIR: evidence };
  delete env.ROBOT_COMPANION_UI_GREP;
  const run = spawnSync(process.execPath, ['tests/ui/run-ui-tests.js'], {
    cwd: source, env, stdio: 'inherit', shell: false, timeout: 900000,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, 'unchanged candidate UI harness must pass');
  const read = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8').replace(/^\uFEFF/, ''));
  const totals = requiredVerdict(read('ui-run-result.json'), read('ui-test-counts.json'), read('native-backend-venv.json'), suite);
  assert(fs.existsSync(path.join(evidence, 'native-libraries-ui-actions.json')));
  const screenshots = requiredScreenshots(evidence);
  console.log(JSON.stringify({ suite, totals, screenshots, runtimeCommit: runtime.vscodeCommit }));
}
module.exports = { requiredVerdict, requiredScreenshots, SHOTS, COMMIT };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
