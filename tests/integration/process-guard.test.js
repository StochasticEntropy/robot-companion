"use strict";

// The process guard with real processes: a stand-in extension host starts owned work
// (a detached group whose leader has a child, a plain process, and one it releases),
// registers it and then dies without cleaning up (SIGKILL, as after a remote host's
// disconnect grace or a crash). Registered work must end; released work is untouched.
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const GUARD = path.resolve(__dirname, "../../src/integration/process-guard.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const HOST = `
const { spawn } = require("node:child_process");
const { processGuard } = require(${JSON.stringify(GUARD)});
const sleeper = "setInterval(() => {}, 1000)";
// A group leader that starts a further process, as Robot runs and debug adapters do.
const leader = spawn(process.execPath, ["-e", \`require("node:child_process").spawn(process.execPath, ["-e", \${JSON.stringify(sleeper)}], { stdio: "ignore" }); \${sleeper}\`],
  { detached: process.platform !== "win32", stdio: "ignore" });
const plain = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore" });
const released = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore", detached: true });
processGuard.register(leader.pid, { group: true });
processGuard.register(plain.pid);
processGuard.register(released.pid)();
process.stdout.write(JSON.stringify({ leader: leader.pid, plain: plain.pid, released: released.pid }) + "\\n");
// The test checks that everything runs, then says when the host ends.
process.stdin.once("data", () => {
  if (process.argv[1] === "kill") process.kill(process.pid, "SIGKILL");
  else { processGuard.dispose(); setInterval(() => {}, 1000); }
});
`;

function descendants(pid) {
  const fs = require("node:fs");
  const found = [];
  for (const name of fs.readdirSync("/proc").filter(entry => /^\d+$/.test(entry))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === pid) found.push(Number(name));
    } catch { /* Ended while reading. */ }
  }
  return found;
}

// Everything a journey started, ended whatever the outcome.
function cleanup(host, pids, grandchildren = []) {
  try { host.kill("SIGKILL"); } catch { /* gone */ }
  for (const pid of [pids?.released, pids?.leader, pids?.plain, ...grandchildren]) { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

async function journey(mode) {
  const host = spawn(process.execPath, ["-e", HOST, mode], { stdio: ["pipe", "pipe", "inherit"] });
  const pids = await new Promise((resolve, reject) => {
    let text = "";
    host.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) resolve(JSON.parse(text)); });
    host.on("error", reject);
  });
  let grandchildren = [];
  for (const end = Date.now() + 5000; Date.now() < end && !grandchildren.length; await sleep(50)) grandchildren = descendants(pids.leader);
  try {
    assert.equal(grandchildren.length, 1, "the group leader started its own child");
    for (const pid of [pids.leader, pids.plain, pids.released, ...grandchildren]) assert(alive(pid), `${pid} runs before the host ends`);
  } catch (error) { cleanup(host, pids, grandchildren); throw error; }
  host.stdin.write("end\n");
  return { host, pids, grandchildren };
}

test("registered processes end when the extension host is killed", { skip: process.platform !== "linux" && "Linux /proc check" }, async () => {
  const { host, pids, grandchildren } = await journey("kill");
  await new Promise(resolve => host.once("close", resolve));
  const end = Date.now() + 6000;
  while (Date.now() < end && [pids.leader, pids.plain, ...grandchildren].some(alive)) await sleep(100);
  try {
    assert.deepStrictEqual([pids.leader, pids.plain, ...grandchildren].filter(alive), [], "registered work and its group are gone");
    assert(alive(pids.released), "a released process is not touched");
  } finally { cleanup(host, pids, grandchildren); }
});

test("graceful dispose ends what is still registered and the host keeps running", { skip: process.platform !== "linux" && "Linux /proc check" }, async () => {
  const { host, pids, grandchildren } = await journey("dispose");
  const end = Date.now() + 6000;
  while (Date.now() < end && [pids.leader, pids.plain, ...grandchildren].some(alive)) await sleep(100);
  try {
    assert.deepStrictEqual([pids.leader, pids.plain, ...grandchildren].filter(alive), []);
    assert(alive(pids.released));
    assert(alive(host.pid), "dispose does not end the host");
  } finally { cleanup(host, pids, grandchildren); }
});
