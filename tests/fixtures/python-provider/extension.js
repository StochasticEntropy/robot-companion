const fs = require("fs");
const vscode = require("vscode");
function activate() {
  if (process.env.ROBOT_ENV_PROVIDER_ACTIVATIONS) fs.appendFileSync(process.env.ROBOT_ENV_PROVIDER_ACTIVATIONS, "activated\n");
  let executable = process.env.ROBOT_ENV_PROVIDER_PYTHON;
  const emitter = new vscode.EventEmitter();
  return {
    environments: {
      getActiveEnvironmentPath(uri) { return { path: executable, resource: uri }; },
      async resolveEnvironment(value) { return value.path ? { executable: { uri: vscode.Uri.file(value.path) } } : undefined; },
      onDidChangeActiveEnvironmentPath: emitter.event
    },
    setTestPath(value) { executable = value; emitter.fire({}); }
  };
}
module.exports = { activate };
