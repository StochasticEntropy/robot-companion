const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const source = path.resolve(__dirname, "../..");
const { vscodeExecutable } = require("./cdp-host");
async function main() {
  const executable = await vscodeExecutable();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-environment-hosts-"));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const folders = ["one/Same name", "two/Same name"].map(name => path.join(scratch, name));
  for (const folder of folders) {
    const bin = path.join(folder, ".venv/bin"); fs.mkdirSync(bin, { recursive: true });
    const fixture = fs.readFileSync(path.join(source, "tests/fixtures/environment/synthetic-python.js"), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`);
    fs.writeFileSync(path.join(bin, "python"), fixture, { mode: 0o755 });
    fs.writeFileSync(path.join(folder, "sample.robot"), "*** Test Cases ***\nSample\n    No Operation\n");
  }
  const workspace = path.join(scratch, "two-root.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: folders.map(p => ({ path: p })), settings: {} }));
  const env = { ...process.env, ROBOT_COMPANION_UI_USER_DATA_DIR: profile, ROBOT_ENV_PROVIDER_PYTHON: path.join(folders[0], ".venv/bin/python"), ROBOT_ENV_PROVIDER_ACTIVATIONS: path.join(scratch, "provider-activations") };
  try {
    for (const stage of ["two-root", "restricted"]) {
      const currentProfile = stage === "restricted" ? path.join(scratch, "restricted-profile") : profile;
      fs.mkdirSync(path.join(currentProfile, "User"), { recursive: true });
      fs.writeFileSync(path.join(currentProfile, "User/settings.json"), JSON.stringify({ "security.workspace.trust.enabled": true, "security.workspace.trust.startupPrompt": "never", "window.restoreWindows": "none", "workbench.startupEditor": "none" }));
      if (stage === "restricted") fs.rmSync(env.ROBOT_ENV_PROVIDER_ACTIVATIONS, { force: true });
      const args = [workspace, "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--new-window", `--user-data-dir=${currentProfile}`, `--extensions-dir=${extensions}`, "--remote-debugging-port=0", `--extensionDevelopmentPath=${source}`, `--extensionDevelopmentPath=${path.join(source, "tests/fixtures/python-provider")}`, `--extensionTestsPath=${path.join(source, "tests/ui/environment-host.js")}`];
      if (stage !== "restricted") args.push("--disable-workspace-trust");
      console.log(`Environment host ${stage}: ${executable} (${stage === "restricted" ? "native trust enabled" : "trusted"})`);
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { ...env, ROBOT_ENV_HOST_STAGE: stage, ROBOT_COMPANION_UI_USER_DATA_DIR: currentProfile }, stdio: "inherit" });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${stage} host timeout`)); }, 90000);
        child.on("error", reject); child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${stage} host exit ${code}`)); });
      });
    }
  } finally {
    const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      for (const [i, folder] of folders.entries()) {
        const calls = path.join(folder, ".venv/bin/calls.jsonl"); if (fs.existsSync(calls)) fs.copyFileSync(calls, path.join(evidence, `root-${i}-calls.jsonl`));
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
