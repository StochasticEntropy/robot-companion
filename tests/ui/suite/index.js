const path = require("path");
const Mocha = require("mocha");

async function run() {
  const mocha = new Mocha({
    color: true,
    timeout: 90000,
    ui: "tdd"
  });

  mocha.addFile(path.resolve(__dirname, "folding-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "documentation-preview-click-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "keyword-argument-insert-ui.test.js"));

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} UI test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { run };
