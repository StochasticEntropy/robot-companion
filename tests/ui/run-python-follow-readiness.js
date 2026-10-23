"use strict";

// A normal editor host (not the extension test runner) proves actual picker input,
// cold activation/readiness and workspace-memento persistence across a graceful
// exit. The Python extension API is a controlled stand-in, not Microsoft integration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { launchHost } = require("./cdp-host");
const { nativeBackend } = require("../native-backend");

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-python-follow-ready-"));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const project = path.join(scratch, "Project"), file = path.join(project, "sample.robot");
  const log = path.join(scratch, "python-extension.jsonl");
  const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
  const native = nativeBackend();
  assert.equal(native.skip, undefined, "the offline native backend is required");
  const python = path.join(path.dirname(native.executable), "python");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(file, "*** Test Cases ***\nCold Follow\n    Log    ready\n");
  const fixture = path.join(extensions, "ms-python.python-0.0.1");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "python", publisher: "ms-python", version: "0.0.1",
    engines: { vscode: "^1.85.0" }, main: "index.js", activationEvents: ["onCommand:fixture.pythonReady"] }));
  fs.writeFileSync(path.join(fixture, "index.js"), `const vscode=require('vscode'),fs=require('fs');
const note=event=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,at:Date.now(),pid:process.pid})+String.fromCharCode(10));
const wait=()=>new Promise(resolve=>setTimeout(resolve,2300));
exports.activate=async()=>{note('activation-start');await wait();note('activation-finished');
const changed=new vscode.EventEmitter();return{ready:wait().then(()=>note('ready-finished')),environments:{
getActiveEnvironmentPath:()=>({path:${JSON.stringify(python)}}),
resolveEnvironment:async()=>({executable:{uri:vscode.Uri.file(${JSON.stringify(python)})}}),
onDidChangeActiveEnvironmentPath:changed.event}};};`);
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el=>el.textContent.startsWith('Robot:'))";
  const ready = `${status} && !${status}.textContent.includes('Checking')`;
  const goodStatus = `${status}?.textContent.startsWith('Robot: Python extension (follow) (') && !/unavailable|timed out|missing|failed/.test(${status}.textContent)`;
  const output = "document.querySelector('.output-view')?.innerText || ''";
  const compactOutput = `(${output}).replace(/\\s/g, '')`;
  const phases = [];
  let host;
  try {
    host = await launchHost({ name: "python-follow-first-click", profile, extensions, targets: [project, file], ready });
    await host.cdp.palette("Robot Companion: Select Robot Environment");
    await host.cdp.filter("Python extension");
    await host.cdp.wait("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(row=>row.textContent.includes('Python extension (follow)') && /Robot Framework 7\\./.test(row.textContent))", 20000);
    await host.cdp.retain("python-follow-cold-picker-ready");
    await host.cdp.key("Enter");
    await host.cdp.wait(goodStatus, 20000);
    await host.cdp.palette("Robot Companion: Show Language Service Status");
    if (await host.cdp.eval("document.querySelector('.part.panel')?.getBoundingClientRect().height < 600"))
      await host.cdp.palette("View: Toggle Maximized Panel");
    const firstStatus = await host.cdp.wait(`${compactOutput}.includes('Language:Nativebackend0.1.0.dev7') && ${compactOutput}.includes(${JSON.stringify(python)}) && (${output})`, 20000);
    phases.push({ stage: "first click", status: firstStatus });
    await host.cdp.retain("python-follow-first-click-native-running");
    await host.quit(); host = undefined;

    // Read only the profile this test created, after graceful shutdown flushed it.
    const databases = fs.readdirSync(path.join(profile, "User/workspaceStorage"), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => path.join(profile, "User/workspaceStorage", entry.name, "state.vscdb"))
      .filter(file => fs.existsSync(file));
    const stored = JSON.parse(cp.execFileSync("python3.13", ["-c", "import sqlite3,json,sys\nr=[]\nfor p in sys.argv[1:]:\n c=sqlite3.connect(p)\n for k,v in c.execute(\"SELECT key,value FROM ItemTable WHERE value LIKE '%robotCompanion.environments.v1%'\"):\n  r.append({'key':k,'value':v.decode() if isinstance(v,bytes) else v})\n c.close()\nprint(json.dumps(r))", ...databases], { encoding: "utf8" }));
    const saved = stored.map(row => JSON.parse(row.value)).find(value => value["robotCompanion.environments.v1"]);
    assert.ok(saved, "the normal VS Code host flushed its environment choice to workspace storage");
    const selections = Object.values(saved["robotCompanion.environments.v1"]);
    assert.deepEqual(selections, [{ version: 1, kind: "pythonExtension" }], "the clicked row remains FOLLOW, never a silently pinned path");

    host = await launchHost({ name: "python-follow-cold-reload", profile, extensions, targets: [project, file], ready: goodStatus });
    // No picker or selection action after relaunch: the saved FOLLOW choice starts
    // the same real native backend even though both API startup phases exceed 2 s.
    await host.cdp.palette("Robot Companion: Show Language Service Status");
    if (await host.cdp.eval("document.querySelector('.part.panel')?.getBoundingClientRect().height < 600"))
      await host.cdp.palette("View: Toggle Maximized Panel");
    const reloaded = await host.cdp.wait(`${compactOutput}.includes('Language:Nativebackend0.1.0.dev7') && ${compactOutput}.includes(${JSON.stringify(python)}) && (${output})`, 20000);
    phases.push({ stage: "cold relaunch without reselecting", status: reloaded });
    await host.cdp.retain("python-follow-cold-reload-native-running");
    await host.quit(); host = undefined;
    const events = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    const pids = [...new Set(events.map(event => event.pid))];
    assert.equal(pids.length, 2, "two distinct extension hosts each cold-activated the Python API fixture");
    for (const pid of pids) {
      const times = Object.fromEntries(events.filter(event => event.pid === pid).map(event => [event.event, event.at]));
      assert.ok(times["activation-finished"] - times["activation-start"] >= 2200);
      assert.ok(times["ready-finished"] - times["activation-finished"] >= 2200);
      assert.ok(times["ready-finished"] - times["activation-start"] < 15000);
    }
    if (evidence) fs.writeFileSync(path.join(evidence, "python-follow-ui-result.json"), JSON.stringify({ passed: true, journeys: 1,
      description: "actual first-row click and cold relaunch with persisted FOLLOW choice", python,
      controlledPythonApi: true, realNativeBackend: true, selections, events, phases }, null, 2));
    console.log("PYTHON FOLLOW READINESS HOST: first-row click and cold relaunch passed; FOLLOW storage retained; both startup phases >2 s");
  } catch (error) {
    await host?.cdp.retain("python-follow-readiness-failed").catch(() => {});
    throw error;
  } finally {
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
