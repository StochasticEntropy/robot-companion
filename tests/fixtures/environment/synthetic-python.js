#!/usr/bin/env node
// A controlled recorder, not Python/Robot Framework or a genuine Python provider.
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2), root = path.dirname(__filename);
const modePath = path.join(root, "mode");
const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8") : "healthy";
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ executable: __filename, argv, cwd: process.cwd() }) + "\n");
if (argv[0] === "-c") {
  if (mode === "hung") setInterval(() => {}, 1000);
  else if (mode === "failed") { console.log("bad response"); process.exit(2); }
  else console.log("ROBOT_COMPANION_ENV:" + JSON.stringify({ python: "3.13.7", robot: mode === "missing" ? null : "7.3.2", missing: mode === "missing" }));
} else if (argv[0] === "--version") {
  console.log("Robot Framework 7.3.2 (synthetic)"); process.exit(251);
} else if (argv[0] === "-m" && argv[1] === "pip") {
  if (mode === "installFailed") process.exit(1);
  fs.writeFileSync(modePath, "healthy");
} else {
  const index = argv.indexOf("--outputdir");
  if (index < 0) process.exit(252);
  const output = argv[index + 1]; fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "invocation.json"), JSON.stringify({ executable: __filename, argv, cwd: process.cwd() }));
  for (const name of ["output.xml", "log.html", "report.html"]) fs.writeFileSync(path.join(output, name), "synthetic result");
  console.log("1 test, 1 passed, 0 failed");
}
