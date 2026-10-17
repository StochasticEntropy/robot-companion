// Real install confirmation: the missing-Robot notification's Install action opens the modal, and the
// recorder Python proves Escape and Cancel start nothing while Confirm starts exactly one pip call.
// Nothing is installed and no network is used.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchHost, recorderCalls, writeRecorder, sleep } = require("./cdp-host");

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-install-confirmation-"));
  const folder = path.join(scratch, "Prüfung workspace");
  const python = writeRecorder(path.join(folder, "env/bin/python"), "missing"), robotFile = path.join(folder, "sample.robot");
  fs.writeFileSync(robotFile, "*** Test Cases ***\nSample\n    No Operation\n");
  const calls = () => recorderCalls(python);
  const pip = () => calls().filter(c => c.argv[1] === "pip");
  let host, cdp;
  try {
    host = await launchHost({ name: "install-confirmation", profile: path.join(scratch, "profile"), extensions: path.join(scratch, "extensions"), targets: [folder, robotFile], ready: "[...document.querySelectorAll('.statusbar-item a')].some(el => el.textContent.startsWith('Robot:'))" });
    cdp = host.cdp;
    const dialog = "document.querySelector('.monaco-dialog-box')";
    const toast = text => `[...document.querySelectorAll('.notifications-toasts .notification-list-item')].find(el => el.textContent.includes(${JSON.stringify(text)}))`;
    // Select the missing-Robot Python through the native picker and custom path input.
    await cdp.click("[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))");
    await cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Select Robot Environment')");
    await cdp.filter("Enter path"); await cdp.key("Enter");
    await cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Choose executable type')");
    await cdp.key("Enter"); await cdp.text(python); await cdp.key("Enter");
    const confirmRound = async (round, trigger) => {
      await cdp.away();
      await sleep(1000); // VS Code drops toasts beyond 3 per 800 ms.
      await trigger();
      await cdp.wait(`!!${toast("Robot Framework is not installed in")}`, 15000);
      await cdp.away(); if (round === "escape") await cdp.retain("real-missing-robot-notification");
      await cdp.click(`[...${toast("Robot Framework is not installed in")}.querySelectorAll('.monaco-button')].find(el => el.textContent.trim() === 'Install robotframework')`);
      await cdp.wait(`${dialog}?.textContent.includes('Install robotframework in this Python environment?')`);
      const text = await cdp.eval(`${dialog}.textContent`);
      assert(text.includes(python), text); assert(text.includes("-m pip install robotframework"), text); assert.equal(pip().length, 0);
      if (round === "escape") await cdp.retain("real-install-confirmation");
    };
    // A closing toast from the previous round can linger in the DOM; start each run from none.
    const runSuite = async () => {
      await cdp.palette("Notifications: Clear All Notifications");
      await cdp.wait(`!${toast("Robot Framework is not installed in")}`); await sleep(1000);
      await cdp.palette("Robot Companion: Run Suite");
    };
    // Saving a missing-Robot choice reports it immediately; that notification starts round one.
    await confirmRound("escape", async () => {});
    await cdp.key("Escape"); await cdp.wait(`!${dialog}`); await sleep(1000);
    assert.equal(pip().length, 0, "Escape must start no installation");
    await confirmRound("cancel", runSuite);
    await cdp.click(`[...${dialog}.querySelectorAll('.monaco-button')].find(el => el.textContent.trim() === 'Cancel')`);
    await cdp.wait(`!${dialog}`); await sleep(1000);
    assert.equal(pip().length, 0, "Cancel must start no installation");
    await confirmRound("confirm", runSuite);
    await cdp.click(`[...${dialog}.querySelectorAll('.monaco-button')].find(el => el.textContent.trim() === 'Install robotframework')`);
    await cdp.wait(`!!${toast("Robot Framework is available in")}`, 20000);
    await cdp.wait("[...document.querySelectorAll('.statusbar-item a')].some(el => el.textContent.startsWith('Robot: python (3.13.7)') && !el.textContent.includes('not installed'))");
    await cdp.retain("real-install-success");
    const installs = pip();
    assert.equal(installs.length, 1, JSON.stringify(calls()));
    assert.deepStrictEqual(installs[0], { executable: python, argv: ["-m", "pip", "install", "robotframework"], cwd: fs.realpathSync(folder) });
    assert(!calls().some(c => c.argv[1] === "robot"), "Recovery never starts a run with the missing environment");
    console.log("INSTALL CONFIRMATION HOST: notification -> modal; Escape 0, Cancel 0, Confirm 1 exact pip call");
  } catch (error) {
    console.error("Install confirmation host failed:", error); process.exitCode = 1;
    try {
      await cdp?.retain("failure");
      console.error("Toast buttons at failure:", await cdp?.eval("JSON.stringify([...document.querySelectorAll('.notifications-toasts .notification-list-item')].map(el => ({ text: el.textContent.slice(0, 120), visible: !!el.getClientRects().length })))"));
    } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "install-confirmation-calls.json"), JSON.stringify(calls(), null, 2)); }
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
