"use strict";

const vscode = require("vscode");

// Share only work that is still in flight. A later interaction must re-read
// native source identity: filesystem notifications alone cannot prove freshness.
class SharedDefinitionRequests {
  constructor() { this.documents = new WeakMap(); }

  request(document, context, position, token, load) {
    if (token?.isCancellationRequested) return Promise.resolve(undefined);
    let state = this.documents.get(document);
    if (!state || state.version !== document.version || state.context !== context) {
      state = { version: document.version, context, entries: new Map() };
      this.documents.set(document, state);
    }
    const key = `${position.line}:${position.character}`;
    let entry = state.entries.get(key);
    if (entry && [...entry.consumers].every(consumer => consumer.token?.isCancellationRequested)) {
      state.entries.delete(key);
      entry.cancellation.cancel();
      entry = undefined;
    }
    if (!entry) {
      const cancellation = new vscode.CancellationTokenSource();
      entry = { cancellation, consumers: new Set() };
      state.entries.set(key, entry);
      entry.promise = Promise.resolve().then(() => load(cancellation.token)).finally(() => {
        if (state.entries.get(key) === entry) state.entries.delete(key);
        cancellation.dispose();
      });
    }
    const consumer = { token };
    entry.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let finished = false;
      let listener;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        listener?.dispose();
        entry.consumers.delete(consumer);
        if (entry.consumers.size === 0 && state.entries.get(key) === entry) {
          state.entries.delete(key);
          entry.cancellation.cancel();
        }
        if (error) reject(error);
        else resolve(result);
      };
      listener = token?.onCancellationRequested?.(() => finish(undefined, undefined));
      if (token?.isCancellationRequested) finish(undefined, undefined);
      entry.promise.then(result => finish(undefined, result), error => finish(error));
    });
  }
}

module.exports = { SharedDefinitionRequests };
