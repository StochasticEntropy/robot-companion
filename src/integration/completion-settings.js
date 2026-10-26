"use strict";

// Read-only editor diagnostics. Restrict the output to suggestion settings and
// extension identities; workspace paths and unrelated configuration stay private.
const SETTINGS = ["quickSuggestions", "quickSuggestionsDelay", "suggestOnTriggerCharacters",
  "suggest.snippetsPreventQuickSuggestions", "inlineSuggest.enabled", "inlineSuggest.suppressSuggestions"];
const SCOPES = ["defaultValue", "globalValue", "workspaceValue", "workspaceFolderValue",
  "defaultLanguageValue", "globalLanguageValue", "workspaceLanguageValue", "workspaceFolderLanguageValue"];
function completionSettings(vscode, document, extensionVersion) {
  if (!document || document.languageId !== "robotframework") return undefined;
  const config = vscode.workspace.getConfiguration("editor", document);
  const settings = {};
  for (const key of SETTINGS) {
    const inspected = config.inspect(key) || {};
    settings[key] = { effective: config.get(key), scopes: Object.fromEntries(SCOPES
      .filter(scope => inspected[scope] !== undefined).map(scope => [scope, inspected[scope]])) };
  }
  const contributors = [];
  for (const extension of vscode.extensions.all) {
    const defaults = extension.packageJSON?.contributes?.configurationDefaults || {};
    for (const [selector, values] of Object.entries(defaults)) {
      if (!selector.split(/(?=\[)/).includes("[robotframework]") || !values || typeof values !== "object") continue;
      const suggestions = Object.fromEntries(SETTINGS.filter(key => Object.hasOwn(values, "editor." + key))
        .map(key => [key, values["editor." + key]]));
      if (Object.keys(suggestions).length) contributors.push({ id: extension.id, version: extension.packageJSON.version, selector, settings: suggestions });
    }
  }
  return { extensionVersion, vscodeVersion: vscode.version, languageId: document.languageId, settings, contributors };
}
module.exports = { completionSettings };
