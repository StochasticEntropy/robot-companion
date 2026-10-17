// Saved environments survive a real restart: choose .venv per root in two identical-named roots
// through the picker, exit VS Code gracefully (Ctrl+Q, File > Exit), relaunch with the same profile, then run
// Run Test (CodeLens) and Run Suite in each root. Recorder calls prove which interpreter ran.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchHost, recorderCalls, writeRecorder, sleep } = require("./cdp-host");

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-environment-restart-"));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const roots = ["one/Same name", "two/Same name"].map(name => path.join(scratch, name));
  const pythons = roots.map(root => writeRecorder(path.join(root, ".venv/bin/python")));
  const files = roots.map(root => path.join(root, "sample.robot"));
  for (const file of files) fs.writeFileSync(file, "*** Test Cases ***\nSample\n    No Operation\n");
  const workspace = path.join(scratch, "two-root.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: roots.map(p => ({ path: p })) }));
  const robotRuns = index => recorderCalls(pythons[index]).filter(call => call.argv[1] === "robot");
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
  const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
  let host;
  // One run in root `index`; the other root's recorder must stay untouched.
  const expectRun = async (index, start, kind) => {
    const before = [robotRuns(0).length, robotRuns(1).length];
    await start();
    for (const end = Date.now() + 20000; robotRuns(index).length === before[index]; await sleep(100)) if (Date.now() > end) throw new Error(`No ${kind} run in root ${index}`);
    const run = robotRuns(index).at(-1);
    assert.equal(run.executable, pythons[index]); assert.deepStrictEqual(run.argv.slice(0, 2), ["-m", "robot"]);
    assert.equal(run.cwd, fs.realpathSync(roots[index])); assert.equal(robotRuns(1 - index).length, before[1 - index], "No leakage into the other root");
    if (kind === "test") assert(run.argv.includes("--test"), JSON.stringify(run.argv));
    await sleep(1500); // Let the run finish before the next one (single-run guard).
  };
  const open = async file => {
    await host.cdp.palette("Go to File");
    await host.cdp.text(file);
    await host.cdp.wait("document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes('sample.robot')");
    await host.cdp.key("Enter");
    await host.cdp.wait(`${status} && !${status}.textContent.includes('Checking')`);
  };
  const runSuite = () => host.cdp.palette("Robot Companion: Run Suite");
  try {
    host = await launchHost({ name: "restart-write", profile, extensions, targets: [workspace, files[0]], ready: `!!${status}` });
    for (const index of [0, 1]) {
      await open(files[index]);
      await host.cdp.click(status);
      await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Robot Framework 7.3.2')");
      await host.cdp.filter(".venv"); await host.cdp.key("Enter");
      await host.cdp.wait(`${status}?.textContent.startsWith('Robot: .venv (3.13.7)')`);
      await expectRun(index, runSuite, "suite");
    }
    await host.cdp.retain("restart-before-exit");
    await host.quit();
    host = await launchHost({ name: "restart-read", profile, extensions, targets: [workspace, files[0]], ready: `!!${status}` });
    for (const index of [0, 1]) {
      await open(files[index]);
      await host.cdp.wait(`${status}?.textContent.startsWith('Robot: .venv (3.13.7)')`);
      if (index === 0) await host.cdp.retain("restart-after-relaunch");
      await expectRun(index, () => host.cdp.click("[...document.querySelectorAll('.contentWidgets .codelens-decoration a, .codelens-decoration a')].find(el => el.textContent.trim() === 'Run Test')"), "test");
      await expectRun(index, runSuite, "suite");
    }
    console.log("ENVIRONMENT RESTART HOST: per-root .venv choices survived Ctrl+Q exit and relaunch; Run Test and Run Suite used them without leakage");
  } catch (error) {
    console.error("Environment restart host failed:", error); process.exitCode = 1;
    try { await host?.cdp.retain("restart-failure"); } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "restart-calls.json"), JSON.stringify(pythons.map(recorderCalls), null, 2)); }
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
