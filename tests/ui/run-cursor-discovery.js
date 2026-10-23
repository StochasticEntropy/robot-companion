"use strict";

// A normal VS Code host, real native backend and actual editor/debugger input.
// The public Python API is a controlled delayed stand-in, not Microsoft integration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { launchHost, sleep } = require("./cdp-host");
const { nativeBackend } = require("../native-backend");

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-cursor-discovery-"));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const project = path.join(scratch, "Project"), suite = path.join(project, "sample.robot");
  const resource = path.join(project, "helper.resource"), log = path.join(scratch, "debug-api.jsonl");
  const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
  const native = nativeBackend();
  assert.equal(native.skip, undefined, "the offline native backend is required");
  const python = path.join(path.dirname(native.executable), "python");
  fs.mkdirSync(project, { recursive: true });
  const suiteText = ["*** Settings ***", "Resource    helper.resource", "", "*** Variables ***", "${SEED}    Cameron", "",
    "*** Test Cases ***", "Cold Follow", "    ${result}=    Safe Echo    ${SEED}", "    Should Be Equal    ${result}    Cameron", "",
    "Not Selected", "    Fail    This test must not run.", ""].join("\n");
  fs.writeFileSync(resource, ["*** Keywords ***", "Safe Echo", "    [Arguments]    ${value}", "    ${copy}=    Set Variable    ${value}", "    RETURN    ${copy}", ""].join("\n"));
  const starter = path.join(project, "starter.robot");
  fs.writeFileSync(starter, "*** Test Cases ***\nExisting Test\n    No Operation\n");
  const discoveryLog = path.join(scratch, "discovery-requests.jsonl");
  const wrapper = path.join(scratch, "delay-full-discovery.js");
  fs.writeFileSync(wrapper, [
    "const cp=require('node:child_process'),fs=require('node:fs');",
    `const {frame,MessageReader}=require(${JSON.stringify(path.resolve(__dirname, "../../src/integration/lsp-session"))});`,
    `const child=cp.spawn(${JSON.stringify(native.executable)},['discovery'],{stdio:['pipe','pipe','inherit']});`,
    "child.stdout.pipe(process.stdout);child.stdin.on('error',()=>{});child.on('exit',code=>process.exit(code||0));",
    `const reader=new MessageReader(message=>{if(message.method==='robotCompanion/discoverTests')fs.appendFileSync(${JSON.stringify(discoveryLog)},JSON.stringify({document:message.params.documentUri||null,pid:process.pid,at:Date.now()})+String.fromCharCode(10));`,
    "if(message.method==='robotCompanion/discoverTests'&&!message.params.documentUri)setTimeout(()=>{if(!child.killed)child.stdin.write(frame(message));},12000).unref();else child.stdin.write(frame(message));});",
    "process.stdin.on('data',chunk=>reader.accept(chunk));process.stdin.on('end',()=>child.stdin.end());"
  ].join("\n"));
  const { nativeDescriptor } = require("../../src/integration/native-backend");
  const descriptor = JSON.parse(JSON.stringify(nativeDescriptor({workspaceUri:pathToFileURL(project).href,cwd:project,executable:native.executable,services:["debug","discovery"]})));
  descriptor.services.discovery={executable:process.execPath,argv:[wrapper],transport:"stdio"};
  fs.mkdirSync(path.join(project,".vscode"));
  fs.writeFileSync(path.join(project,".vscode/settings.json"),JSON.stringify({"robotCompanion.executionBackend":descriptor,
    "robotCompanion.languageBackend":nativeDescriptor({workspaceUri:pathToFileURL(project).href,cwd:project,executable:native.executable,services:["language"]})}));
  const fixture = path.join(extensions, "ms-python.python-0.0.1");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "python", publisher: "ms-python", version: "0.0.1",
    engines: { vscode: "^1.85.0" }, main: "index.js", activationEvents: ["onCommand:fixture.pythonReady"] }));
  fs.writeFileSync(path.join(fixture, "index.js"), [
    "const vscode=require('vscode'),fs=require('fs');",
    `const note=(event,data={})=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,...data,at:Date.now(),pid:process.pid})+String.fromCharCode(10));`,
    "const wait=()=>new Promise(resolve=>setTimeout(resolve,100));",
    "exports.activate=async context=>{note('activation-start');await wait();note('activation-finished');",
    "context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(()=>note('breakpoints',{items:vscode.debug.breakpoints.map(b=>({path:b.location?.uri.fsPath,line:b.location?.range.start.line+1}))})));",
    "context.subscriptions.push(vscode.debug.onDidStartDebugSession(s=>note('session-start',{id:s.id,configuration:s.configuration})));",
    "context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(s=>note('session-end',{id:s.id})));",
    "context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('robotcompanion',{createDebugAdapterTracker:s=>({onWillReceiveMessage:message=>note('dap',{session:s.id,direction:'to',message}),onDidSendMessage:message=>note('dap',{session:s.id,direction:'from',message})})}));",
    "const changed=new vscode.EventEmitter();return{ready:wait().then(()=>note('ready-finished')),environments:{",
    `getActiveEnvironmentPath:()=>({path:${JSON.stringify(python)}}),`,
    `resolveEnvironment:async()=>({executable:{uri:vscode.Uri.file(${JSON.stringify(python)})}}),`,
    "onDidChangeActiveEnvironmentPath:changed.event}};};"
  ].join("\n"));
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const messages = () => events().filter(e => e.event === "dap");
  const stopEvents = () => messages().filter(e => e.direction === "from" && e.message.event === "stopped");
  async function until(predicate, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(75); }
    throw new Error(`Timed out: ${label}`);
  }
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el=>el.textContent.startsWith('Robot:'))";
  const menuElements = `(() => { const all = root => [...root.querySelectorAll('.action-label'), ...[...root.querySelectorAll('*')].flatMap(e => e.shadowRoot ? all(e.shadowRoot) : [])]; return all(document); })()`;
  const runProcesses = () => cp.execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")
    .filter(line => /-m robot_companion_backend(?:\.worker | (?:worker|dap)(?: |$))|robot-companion-backend dap|debugpy/.test(line))
    .map(line => { const [pid, ...args] = line.trim().split(/\s+/); return { pid: Number(pid), args: args.join(" ") }; })
    .filter(item => { try { return fs.readFileSync(`/proc/${item.pid}/environ`, "utf8").split("\0").includes(`ROBOT_COMPANION_UI_USER_DATA_DIR=${profile}`); } catch { return false; } });
  let host;
  process.env.ROBOT_COMPANION_UI_USER_DATA_DIR = profile;
  try {
    host = await launchHost({ name: "cursor-discovery", profile, extensions, targets: [project, starter], ready: `!!${status}` });
    await host.cdp.palette("Robot Companion: Select Robot Environment");
    await host.cdp.filter("Python extension");
    await host.cdp.wait("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(row=>row.textContent.includes('Python extension') && /Robot Framework 7\\./.test(row.textContent))", 20000);
    await host.cdp.key("Enter");
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: Python extension (')`, 20000);
    await until(() => fs.existsSync(discoveryLog), "initial full-workspace discovery requested");
    await sleep(10500);
    await host.cdp.palette("Robot Companion: Show Language Service Status");
    if (await host.cdp.eval("document.querySelector('.part.panel')?.getBoundingClientRect().height < 600")) await host.cdp.palette("View: Toggle Maximized Panel");
    const initialFailure = await host.cdp.wait("(document.querySelector('.output-view')?.innerText||'').replace(/\\s/g,'').includes(\"discoverTests' timed out.\".replace(/\\s/g,'')) && document.querySelector('.output-view').innerText",20000);
    await host.cdp.retain("cursor-discovery-initial-full-timeout");
    for(const type of ["keyDown","keyUp"]) await host.cdp.cdp.send("Input.dispatchKeyEvent",{type,key:"j",code:"KeyJ",windowsVirtualKeyCode:74,modifiers:2},host.cdp.cdp.pageSession);
    fs.writeFileSync(suite, suiteText);
    await host.cdp.palette("Go to File");await host.cdp.text(suite);await host.cdp.wait("document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes('sample.robot')");await host.cdp.key("Enter");
    await host.cdp.wait("document.querySelector('.tabs-container .tab.active')?.textContent.includes('sample.robot')");
    for(const type of ["keyDown","keyUp"]) await host.cdp.cdp.send("Input.dispatchKeyEvent",{type,key:"End",code:"End",windowsVirtualKeyCode:35,modifiers:2},host.cdp.cdp.pageSession);
    await host.cdp.text("# Saved in VS Code");
    for(const type of ["keyDown","keyUp"]) await host.cdp.cdp.send("Input.dispatchKeyEvent",{type,key:"s",code:"KeyS",windowsVirtualKeyCode:83,modifiers:2},host.cdp.cdp.pageSession);
    await until(()=>fs.readFileSync(suite,"utf8").startsWith(suiteText) && fs.readFileSync(suite,"utf8").includes("# Saved in VS Code"),"the new suite was saved through the editor");
    await host.cdp.wait("document.querySelector('.codelens-decoration')?.textContent.includes('Run')", 20000);
    await host.cdp.palette("Notifications: Clear All Notifications");
    const call = "[...document.querySelectorAll('.monaco-editor .view-lines .view-line')].find(e=>e.getClientRects().length && e.innerText.replaceAll(String.fromCharCode(160), ' ').includes('Safe Echo'))";
    await host.cdp.click(call);
    await host.cdp.key("F9");
    await until(() => events().some(e => e.event === "breakpoints" && e.items.some(b => b.path === suite && b.line === 9)), "F9 creates only the intended suite breakpoint");
    const body = await host.cdp.eval(`(() => { const r = (${call}).getBoundingClientRect(); return {x:r.x+100,y:r.y+r.height/2}; })()`);
    await host.cdp.cdp.send("Input.dispatchMouseEvent", {type:"mouseMoved",...body}, host.cdp.cdp.pageSession);
    await sleep(150);
    for (const type of ["mousePressed", "mouseReleased"]) await host.cdp.cdp.send("Input.dispatchMouseEvent",
      { type, ...body, button: "right", buttons: type === "mousePressed" ? 2 : 0, clickCount: 1 }, host.cdp.cdp.pageSession);
    const menu = await host.cdp.wait(`${menuElements}.filter(e=>e.getClientRects().length).some(e=>e.innerText==='Debug Test at Cursor') && ${menuElements}.filter(e=>e.getClientRects().length).map(e=>e.innerText)`);
    const index = menu.indexOf("Run Test at Cursor");
    assert.deepEqual(menu.slice(index, index + 3), ["Run Test at Cursor", "Debug Test at Cursor", "Run Suite"]);
    await host.cdp.retain("cursor-discovery-editor-menu");
    await host.cdp.click(`${menuElements}.find(e=>e.getClientRects().length && e.innerText==='Debug Test at Cursor')`);
    const started = await until(() => events().find(e => e.event === "session-start"), "native session starts from editor context menu");
    const runDirectory = path.dirname(started.configuration.args[1]);
    const selection = JSON.parse(fs.readFileSync(path.join(runDirectory, "selection.json"), "utf8")).tests;
    assert.deepEqual(selection, [[suite, 8, "Cold Follow"]], "the cursor chooses one test, excluding the deliberately failing neighbour");
    await until(() => stopEvents().some(e => e.message.body.reason === "breakpoint"), "native breakpoint stop");
    await until(() => messages().some(e => e.message.command === "stackTrace" && e.message.type === "response" &&
      e.message.body?.stackFrames?.[0]?.source?.path === suite && e.message.body.stackFrames[0].line === 9), "suite frame at intended breakpoint");
    await host.cdp.retain("cursor-discovery-breakpoint");
    await sleep(500);
    const before = stopEvents().length;
    for (const type of ["keyDown", "keyUp"]) await host.cdp.cdp.send("Input.dispatchKeyEvent", { type, key: "F11", code: "F11", windowsVirtualKeyCode: 122 }, host.cdp.cdp.pageSession);
    await until(() => stopEvents().length > before && stopEvents().at(-1).message.body.reason === "step", "F11 step into keyword");
    const frame = await until(() => messages().filter(e => e.message.command === "stackTrace" && e.message.type === "response")
      .map(e => e.message.body?.stackFrames?.[0]).find(frame => frame?.source?.path === resource && frame.line === 4), "stepped into the resource keyword");
    await host.cdp.palette("Run and Debug: Focus on Variables View");
    const variableRow = "[...document.querySelectorAll('.debug-variables .monaco-list-row')].find(row=>{ const r=row.getBoundingClientRect(),v=document.querySelector('.debug-variables .monaco-list').getBoundingClientRect(); return r.height && r.top>=v.top && r.bottom<=v.bottom && (row.getAttribute('aria-label')||'').startsWith('${value}, value ') && row.getAttribute('aria-label').includes('Cameron'); })?.getAttribute('aria-label')";
    let variable;
    for (let scroll = 0; scroll < 12; scroll++) {
      variable = await host.cdp.eval(variableRow);
      if (variable) break;
      const centre = await host.cdp.point("document.querySelector('.debug-variables .monaco-list')");
      await host.cdp.cdp.send("Input.dispatchMouseEvent", {type:"mouseWheel",...centre,deltaX:0,deltaY:220}, host.cdp.cdp.pageSession);
      await sleep(250);
    }
    assert.ok(variable, "the keyword argument and its actual value are visible in the Variables tree");
    assert.ok(messages().some(e => e.message.command === "variables" && e.message.type === "response" &&
      e.message.body?.variables?.some(v => v.name === "${value}" && v.value.includes("Cameron"))), "Variables UI value came from the actual DAP response");
    const pausedProcesses = runProcesses();
    assert.ok(pausedProcesses.length, "the selected native debug session owns real worker/DAP processes");
    await host.cdp.retain("cursor-discovery-resource-variable");
    await sleep(500);
    await host.cdp.key("F5");
    await until(() => messages().some(e => e.message.event === "exited" && e.message.body.exitCode === 0), "successful native completion");
    await until(() => events().some(e => e.event === "session-end" && e.id === started.id) && runProcesses().length === 0, "session and owned debug worker processes are gone");
    const output = messages().filter(e => e.message.event === "output").map(e => e.message.body.output || "").join("");
    assert.match(output, /Cold Follow/);
    assert.doesNotMatch(output, /This test must not run/);
    await host.cdp.retain("cursor-discovery-completed");
    if (evidence) fs.writeFileSync(path.join(evidence, "cursor-discovery-result.json"), JSON.stringify({ passed: true, journeys: 1,
      controlledPythonApi: true, realNativeBackend: true, controlledFullDiscoveryDelayMs:12000, initialFailure, discoveryRequests:fs.readFileSync(discoveryLog,"utf8").trim().split("\n").map(JSON.parse), suite, resource, python, menu, selection, frame, variable,
      pausedProcesses, remainingDebugProcesses: runProcesses(), events: events() }, null, 2));
    await host.quit(); host = undefined;
    console.log("CURSOR DISCOVERY HOST: actual editor menu, breakpoint, resource Step Into, Variables and clean native completion passed");
  } catch (error) {
    await host?.cdp.retain("cursor-discovery-failed").catch(() => {});
    if (evidence) fs.writeFileSync(path.join(evidence, "cursor-discovery-events.json"), JSON.stringify(events(), null, 2));
    throw error;
  } finally {
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
