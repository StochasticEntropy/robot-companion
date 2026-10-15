const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const PROBE_FIXTURE = "documentation-preview-security-probe.robot";
const PROBE_COMMAND = "robotCompanionProbe.recordCall";
const FOREIGN_COMMAND = "workbench.action.terminal.new";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function decodeHtmlAttribute(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readContentSecurityPolicy(html) {
  const metas = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g) || [];
  assert.strictEqual(metas.length, 1, "expected exactly one Content-Security-Policy meta element");
  const content = decodeHtmlAttribute(metas[0].match(/content="([^"]*)"/)[1]);
  const directives = new Map();
  for (const part of content.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name, sources);
    }
  }
  return directives;
}

function findHrefs(html, prefix) {
  const hrefs = [];
  const pattern = /href="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(html))) {
    const href = decodeHtmlAttribute(match[1]);
    if (href.startsWith(prefix)) {
      hrefs.push(href);
    }
  }
  return hrefs;
}

suite("Robot Companion documentation preview security", function () {
  this.timeout(90000);

  let extensionTestApi;
  let probeDocument;
  let probeCommandCalls = 0;
  let probeCommandDisposable;

  async function showProbeInPreview() {
    await vscode.window.showTextDocument(probeDocument, { preview: false, preserveFocus: false });
    const parsed = new extensionTestApi.RobotDocumentationService().parse(probeDocument);
    const block = parsed.blocks.find((candidate) => candidate.ownerName === "Preview Security Probe");
    assert(block, "expected the probe documentation block");
    await vscode.commands.executeCommand("robotCompanion.openBlockAt", probeDocument.uri.toString(), block.id);
    await waitFor(() => {
      const snapshot = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      const webview = extensionTestApi.getDocumentationPreviewWebviewForTest();
      return snapshot.visible && snapshot.selectedBlockId === block.id && webview.html.includes("__rcProbeScript");
    }, "the Documentation Preview webview to show the probe block");
    return extensionTestApi.getDocumentationPreviewWebviewForTest();
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();
    extensionTestApi = require(path.join(extension.extensionPath, "src/core/extension.js")).__test__;
    probeCommandDisposable = vscode.commands.registerCommand(PROBE_COMMAND, () => {
      probeCommandCalls += 1;
    });
    const [probeUri] = await vscode.workspace.findFiles(PROBE_FIXTURE);
    assert(probeUri, `Expected fixture ${PROBE_FIXTURE} in the workspace.`);
    probeDocument = await vscode.workspace.openTextDocument(probeUri);
  });

  suiteTeardown(() => {
    probeCommandDisposable?.dispose();
  });

  test("raw HTML in documentation cannot run script in the preview webview", async () => {
    const webview = await showProbeInPreview();
    const html = webview.html;

    const directives = readContentSecurityPolicy(html);
    assert.deepStrictEqual(directives.get("default-src"), ["'none'"]);
    const scriptSources = directives.get("script-src") || [];
    assert.strictEqual(scriptSources.length, 1, `script-src must allow only the nonce, got ${scriptSources.join(" ")}`);
    const nonceMatch = scriptSources[0].match(/^'nonce-([0-9a-f]{32})'$/);
    assert(nonceMatch, `script-src must be a nonce source, got ${scriptSources[0]}`);
    for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "*"]) {
      assert(!scriptSources.includes(forbidden), `script-src must not contain ${forbidden}`);
    }
    assert(webview.cspSource, "expected the webview to expose its cspSource");
    const styleSources = directives.get("style-src") || [];
    for (const source of webview.cspSource.split(/\s+/)) {
      assert(styleSources.includes(source), `style-src should name the webview source ${source}`);
    }

    // The extension's own script carries the nonce; the documentation's <script> and onerror do not.
    const nonce = nonceMatch[1];
    assert.strictEqual(html.split(`nonce="${nonce}"`).length - 1, 1, "only the extension's own script carries the nonce");
    const extensionScriptStart = html.indexOf(`<script nonce="${nonce}">`);
    const probeScriptStart = html.indexOf("__rcProbeScript");
    assert(extensionScriptStart > probeScriptStart, "the probe content is rendered before, and outside, the extension script");
    assert(!/<script[^>]*nonce[^>]*>\s*window\.__rcProbeScript/.test(html), "the documentation <script> must not carry a nonce");

    // A fresh nonce on every render, so documentation cannot reuse one it has seen.
    const parsed = new extensionTestApi.RobotDocumentationService().parse(probeDocument);
    const rebuilt = extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
      { documentUri: probeDocument.uri.toString(), blocks: parsed.blocks },
      parsed.blocks[0],
      ""
    );
    assert(!rebuilt.includes(nonce), "each preview render must use a fresh nonce");

    if (process.env.ROBOT_COMPANION_PREVIEW_HTML_DUMP) {
      fs.writeFileSync(process.env.ROBOT_COMPANION_PREVIEW_HTML_DUMP, html, "utf8");
    }
  });

  test("command links run only Robot Companion commands; preview navigation still works", async () => {
    const webview = await showProbeInPreview();
    const html = webview.html;
    const allowlist = extensionTestApi.PREVIEW_COMMAND_URI_ALLOWLIST;

    assert(Array.isArray(webview.options.enableCommandUris), "native command links must use an allowlist, not true");
    assert.deepStrictEqual([...webview.options.enableCommandUris], [...allowlist]);
    assert(allowlist.every((commandId) => commandId.startsWith("robotCompanion.")));
    assert(!allowlist.includes(FOREIGN_COMMAND));
    assert(!allowlist.includes(PROBE_COMMAND));

    // The documentation's foreign links reach the webview, and the managed bridge ignores them.
    const [foreignLink] = findHrefs(html, `command:${FOREIGN_COMMAND}`);
    const [probeLink] = findHrefs(html, `command:${PROBE_COMMAND}`);
    assert(foreignLink, "expected the probe terminal link in the rendered preview");
    assert(probeLink, "expected the probe record link in the rendered preview");

    const terminalCountBefore = vscode.window.terminals.length;
    await webview.handleMessage({ type: "executeCommandUri", commandUri: probeLink });
    await webview.handleMessage({ type: "executeCommandUri", commandUri: foreignLink });
    assert.strictEqual(await extensionTestApi.executeManagedCommandUri(probeLink), false);
    await sleep(300);
    assert.strictEqual(probeCommandCalls, 0, "a foreign command link must not run");
    assert.strictEqual(vscode.window.terminals.length, terminalCountBefore, "a terminal link must not open a terminal");

    // The preview's own jump link still opens the source at the test.
    const [ownerJump] = findHrefs(html, "command:robotCompanion.openLocation?");
    assert(ownerJump, "expected the preview's own jump-to-source link");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await webview.handleMessage({ type: "executeCommandUri", commandUri: ownerJump });
    await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      return (
        editor &&
        editor.document.uri.toString() === probeDocument.uri.toString() &&
        editor.document.lineAt(editor.selection.active.line).text === "Preview Security Probe"
      );
    }, "the owner jump link to open the probe test in the editor");
    assert.strictEqual(probeCommandCalls, 0);
  });
});
