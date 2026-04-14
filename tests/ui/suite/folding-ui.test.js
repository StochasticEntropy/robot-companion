const assert = require("assert");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const FIXTURE_SCENARIOS = [
  {
    fixtureName: "folding-regression.robot",
    label: "testcase owner",
    ownerLine: 1,
    expectedBodyRanges: {
      headline: [
        [2, 8],
        [9, 12]
      ],
      firstLevel: [
        [3, 6],
        [7, 8],
        [10, 12]
      ],
      secondLevel: [[5, 6]]
    },
    headlineCursorJumps: [{ from: 2, to: 9 }],
    terminalHeadlineCursorExpectation: { from: 9, to: 9 },
    firstLevelCursorJumps: [{ from: 3, to: 7 }],
    secondLevelCursorJumps: [{ from: 5, to: 7 }]
  },
  {
    fixtureName: "folding-regression-following-owner.robot",
    label: "headline before next owner",
    ownerLine: 1,
    expectedBodyRanges: {
      headline: [
        [2, 3],
        [4, 6]
      ],
      firstLevel: [],
      secondLevel: []
    },
    headlineCursorJumps: [
      { from: 2, to: 4 },
      { from: 4, to: 7 }
    ],
    terminalHeadlineCursorExpectation: { from: 4, to: 7 },
    firstLevelCursorJumps: [],
    secondLevelCursorJumps: []
  },
  {
    fixtureName: "folding-regression-keywords.robot",
    label: "keyword owner",
    ownerLine: 1,
    expectedBodyRanges: {
      headline: [
        [2, 8],
        [9, 12]
      ],
      firstLevel: [
        [3, 6],
        [7, 8],
        [10, 12]
      ],
      secondLevel: [[5, 6]]
    },
    headlineCursorJumps: [{ from: 2, to: 9 }],
    terminalHeadlineCursorExpectation: { from: 9, to: 9 },
    firstLevelCursorJumps: [{ from: 3, to: 7 }],
    secondLevelCursorJumps: [{ from: 5, to: 7 }]
  },
  {
    fixtureName: "folding-regression-large.robot",
    label: "large testcase owner",
    ownerLine: 10,
    expectedBodyRanges: {
      headline: [
        [27, 28],
        [29, 40],
        [41, 73],
        [74, 159]
      ],
      firstLevel: [
        [30, 32],
        [33, 39],
        [42, 56],
        [58, 72],
        [79, 96],
        [97, 137],
        [138, 159]
      ],
      secondLevel: [
        [84, 95],
        [139, 158]
      ]
    },
    headlineCursorJumps: [
      { from: 27, to: 29 },
      { from: 29, to: 41 },
      { from: 41, to: 74 }
    ],
    firstLevelCursorJumps: [
      { from: 29, to: 30 },
      { from: 30, to: 33 },
      { from: 33, to: 41 },
      { from: 41, to: 42 },
      { from: 42, to: 57 },
      { from: 79, to: 97 },
      { from: 97, to: 138 }
    ],
    secondLevelCursorJumps: [{ from: 84, to: 97 }]
  },
  {
    fixtureName: "folding-regression-adjustment.robot",
    label: "large adjustment testcase owner",
    ownerLine: 13,
    previewSourceJumpLines: [162, 186, 199, 206, 207, 238],
    expectedBodyRanges: {
      headline: [
        [74, 156],
        [157, 204],
        [205, 266],
        [267, 310]
      ],
      firstLevel: [
        [75, 88],
        [89, 132],
        [133, 155],
        [158, 177],
        [178, 184],
        [185, 193],
        [194, 197],
        [198, 203],
        [268, 309]
      ],
      secondLevel: [
        [162, 176],
        [186, 192],
        [199, 202],
        [238, 265]
      ]
    },
    headlineCursorJumps: [
      { from: 73, to: 74 },
      { from: 74, to: 157 },
      { from: 157, to: 205 },
      { from: 205, to: 267 },
      { from: 267, to: 311 }
    ],
    firstLevelCursorJumps: [
      { from: 74, to: 75 },
      { from: 75, to: 89 },
      { from: 89, to: 133 },
      { from: 133, to: 157 },
      { from: 157, to: 158 },
      { from: 158, to: 178 },
      { from: 178, to: 185 },
      { from: 185, to: 194 },
      { from: 194, to: 198 },
      { from: 198, to: 205 },
      { from: 267, to: 268 },
      { from: 268, to: 311 }
    ],
    secondLevelCursorJumps: [
      { from: 162, to: 177 },
      { from: 186, to: 193 },
      { from: 199, to: 205 },
      { from: 238, to: 267 }
    ]
  }
];

const MIXED_DOCUMENTATION_PREVIEW_SCENARIOS = [
  {
    fixtureName: "documentation-inline-mixed-simple.robot",
    expectedTargetLinesInOrder: [3, 4, 5, 7, 8, 11, 12, 13, 16, 19, 20],
    previewSourceJumpLines: [11, 12, 13, 16, 19, 20]
  },
  {
    fixtureName: "documentation-inline-mixed-involved.robot",
    expectedTargetLinesInOrder: [6, 7, 8, 11, 12, 13, 14, 22, 23, 24, 28, 33, 38, 43, 44, 48, 52, 57, 58, 62],
    previewSourceJumpLines: [22, 23, 24, 28, 33, 38, 43, 44, 48, 52, 57, 58, 62]
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError = undefined;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function setCursor(editor, line, character = 0) {
  const focusedEditor = await vscode.window.showTextDocument(editor.document, {
    preview: false,
    preserveFocus: false,
    viewColumn: editor.viewColumn
  });
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  const position = new vscode.Position(line, character);
  const selection = new vscode.Selection(position, position);
  focusedEditor.selection = selection;
  focusedEditor.revealRange(new vscode.Range(position, position));
  await sleep(75);
  return focusedEditor;
}

async function waitForCursorDownResult(editor, startLine, expectedLine, label) {
  let lastActualLine = -1;
  try {
    await waitFor(async () => {
      const focusedEditor = await setCursor(editor, startLine);
      await vscode.commands.executeCommand("cursorDown");
      lastActualLine = (vscode.window.activeTextEditor || focusedEditor).selection.active.line;
      return lastActualLine === expectedLine;
    }, label);
  } catch (error) {
    throw new Error(`${error.message} Expected line ${expectedLine}, last actual ${lastActualLine}.`);
  }
}

async function assertCursorJumpSequence(editor, jumps, descriptionPrefix) {
  for (const jump of jumps) {
    const fromLine = Math.max(0, Number(jump?.from) || 0);
    const toLine = Math.max(0, Number(jump?.to) || 0);
    const label =
      jump?.label ||
      `${descriptionPrefix} should move from line ${fromLine + 1} to line ${toLine + 1}`;
    await waitForCursorDownResult(editor, fromLine, toLine, label);
  }
}

async function placeCursorAtDocumentEnd(editor) {
  const safeLastLine = Math.max(0, Number(editor?.document?.lineCount) - 1);
  return setCursor(editor, safeLastLine);
}

async function runFoldCommand(command) {
  await vscode.commands.executeCommand("workbench.action.focusSideBar");
  await sleep(100);
  await vscode.commands.executeCommand(command);
}

async function openNonRobotEditor() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
  const packageDocument = await vscode.workspace.openTextDocument(path.join(extension.extensionPath, "package.json"));
  await vscode.window.showTextDocument(packageDocument, {
    preview: false,
    preserveFocus: false
  });
  await sleep(75);
}

async function runPreviewFoldCommand(command, document) {
  await openNonRobotEditor();
  await vscode.commands.executeCommand("workbench.action.focusSideBar");
  await sleep(100);
  await vscode.commands.executeCommand(command, document.uri.toString());
  await sleep(150);
  const targetEditor =
    vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString()) ||
    vscode.window.activeTextEditor;
  assert(targetEditor, `Expected a visible editor for ${path.basename(document.uri.fsPath)} after ${command}.`);
  await vscode.window.showTextDocument(targetEditor.document, {
    preview: false,
    preserveFocus: false,
    viewColumn: targetEditor.viewColumn
  });
  return vscode.window.activeTextEditor || targetEditor;
}

async function getActiveProviderRanges(document) {
  const ranges =
    (await vscode.commands.executeCommand("_executeFoldingRangeProvider", document.uri)) || [];
  return ranges
    .map((range) => [Math.max(0, Number(range.start) - 1), Math.max(0, Number(range.end) - 1)])
    .filter((range) => Number.isInteger(range[0]) && Number.isInteger(range[1]))
    .sort((left, right) => {
      if (left[0] !== right[0]) {
        return left[0] - right[0];
      }
      return left[1] - right[1];
    });
}

function extendExpectedRangesAcrossBlankLines(document, expectedRanges) {
  const sourceRanges = (Array.isArray(expectedRanges) ? expectedRanges : [])
    .map((range) => [Math.max(0, Number(range?.[0]) || 0), Math.max(0, Number(range?.[1]) || 0)])
    .sort((left, right) => {
      if (left[0] !== right[0]) {
        return left[0] - right[0];
      }
      return left[1] - right[1];
    });
  const documentLastLine = Math.max(0, Number(document?.lineCount) - 1);

  return sourceRanges.map((currentRange) => {
    let nextBlockingStartLine = documentLastLine + 1;
    for (const candidateRange of sourceRanges) {
      if (candidateRange[0] > currentRange[1]) {
        nextBlockingStartLine = candidateRange[0];
        break;
      }
    }
    let expandedEndLine = currentRange[1];

    while (expandedEndLine < documentLastLine && expandedEndLine + 1 < nextBlockingStartLine) {
      const nextLineText = String(document.lineAt(expandedEndLine + 1)?.text || "");
      if (nextLineText.trim().length > 0) {
        break;
      }
      expandedEndLine += 1;
    }

    return [currentRange[0], expandedEndLine];
    });
}

function getExpectedStepRanges(scenario) {
  return [
    ...(Array.isArray(scenario?.expectedBodyRanges?.firstLevel) ? scenario.expectedBodyRanges.firstLevel : []),
    ...(Array.isArray(scenario?.expectedBodyRanges?.secondLevel) ? scenario.expectedBodyRanges.secondLevel : [])
  ].sort((left, right) => {
    if (left[0] !== right[0]) {
      return left[0] - right[0];
    }
    return left[1] - right[1];
  });
}

async function assertActiveProviderRanges(document, expectedRanges, label) {
  const normalizedExpectedRanges = extendExpectedRangesAcrossBlankLines(document, expectedRanges);
  await waitFor(async () => {
    const actualRanges = await getActiveProviderRanges(document);
    assert.deepStrictEqual(actualRanges, normalizedExpectedRanges);
    return true;
  }, label);
}

function decodeDocumentationRenderTargets(renderedHtml) {
  const targetMatch = String(renderedHtml || "").match(/data-doc-render-targets="([^"]+)"/);
  assert(targetMatch, "expected rendered preview HTML to expose encoded source targets");
  return JSON.parse(decodeURIComponent(targetMatch[1]));
}

function parseCommandUri(commandUri) {
  const rawCommandUri = String(commandUri || "");
  const match = rawCommandUri.match(/^command:([^?]+)(?:\?(.*))?$/);
  assert(match, `expected a VS Code command URI but got ${rawCommandUri}`);
  const command = decodeURIComponent(match[1]);
  const args = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
  return {
    command,
    args: Array.isArray(args) ? args : [args]
  };
}

async function executeCommandUri(commandUri) {
  const parsed = parseCommandUri(commandUri);
  return vscode.commands.executeCommand(parsed.command, ...parsed.args);
}

async function createOwnerFold(editor, ownerLine) {
  await setCursor(editor, ownerLine);
  await vscode.commands.executeCommand("editor.fold");
  await sleep(200);
}

suite("Robot Companion documentation folding UI", function () {
  this.timeout(90000);

  const documentsByFixtureName = new Map();
  let editor;
  let extensionTestApi;

  async function resetEditorState(document) {
    editor = await vscode.window.showTextDocument(document, {
      preview: false
    });
    await vscode.commands.executeCommand("robotCompanion.unfoldDocumentation");
    await vscode.commands.executeCommand("editor.unfoldAll");
    await sleep(250);
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();
    extensionTestApi = require(path.join(extension.extensionPath, "src/core/extension.js")).__test__;
    await vscode.commands.executeCommand("robotCompanion.useAsDefaultFoldingProvider");

    const fixtureUris = await vscode.workspace.findFiles("*.robot");
    for (const fixtureUri of fixtureUris) {
      documentsByFixtureName.set(path.basename(fixtureUri.fsPath), await vscode.workspace.openTextDocument(fixtureUri));
    }

    for (const scenario of FIXTURE_SCENARIOS) {
      assert(
        documentsByFixtureName.has(scenario.fixtureName),
        `Expected fixture ${scenario.fixtureName} to be present in the workspace.`
      );
    }
    for (const scenario of MIXED_DOCUMENTATION_PREVIEW_SCENARIOS) {
      assert(
        documentsByFixtureName.has(scenario.fixtureName),
        `Expected fixture ${scenario.fixtureName} to be present in the workspace.`
      );
    }
  });

  test("stores the workspace override for the Robot Companion folding provider", async () => {
    const override = vscode.workspace.getConfiguration().get("[robotframework]");
    assert.strictEqual(
      override["editor.defaultFoldingRangeProvider"],
      EXTENSION_ID,
      "workspace robotframework override should point at this extension"
    );
    assert.strictEqual(
      override["editor.foldingStrategy"],
      "auto",
      "workspace robotframework override should keep automatic folding"
    );
  });

  for (const scenario of FIXTURE_SCENARIOS) {
    suite(`${scenario.label} fixture`, () => {
      let document;

      setup(async () => {
        document = documentsByFixtureName.get(scenario.fixtureName);
        assert(document, `Expected document for fixture ${scenario.fixtureName}.`);
        await resetEditorState(document);
      });

      test("foldDocumentationToHeadlines keeps only the expected headline steps visible in the editor", async () => {
        await placeCursorAtDocumentEnd(editor);
        await runFoldCommand("robotCompanion.foldDocumentationToHeadlines");
        await assertActiveProviderRanges(
          document,
          scenario.expectedBodyRanges.headline,
          "headline fold should expose only headline body ranges through the provider"
        );
        await assertCursorJumpSequence(
          editor,
          scenario.headlineCursorJumps,
          "headline fold"
        );
        if (scenario.terminalHeadlineCursorExpectation) {
          await waitForCursorDownResult(
            editor,
            scenario.terminalHeadlineCursorExpectation.from,
            scenario.terminalHeadlineCursorExpectation.to,
            "headline fold should also collapse the final visible headline body"
          );
        }
      });

      test("foldDocumentationToHeadlines clears an existing owner fold before applying documentation folds", async () => {
        await createOwnerFold(editor, scenario.ownerLine);
        await placeCursorAtDocumentEnd(editor);
        await runFoldCommand("robotCompanion.foldDocumentationToHeadlines");
        await assertActiveProviderRanges(
          document,
          scenario.expectedBodyRanges.headline,
          "headline fold after clearing owner fold should expose only headline body ranges"
        );
        await waitForCursorDownResult(
          editor,
          scenario.ownerLine,
          scenario.ownerLine + 1,
          "owner line should no longer stay collapsed after headline folding"
        );
        await assertCursorJumpSequence(editor, scenario.headlineCursorJumps, "headline fold after clearing owner fold");
        if (scenario.terminalHeadlineCursorExpectation) {
          await waitForCursorDownResult(
            editor,
            scenario.terminalHeadlineCursorExpectation.from,
            scenario.terminalHeadlineCursorExpectation.to,
            "headline fold after clearing owner fold should collapse the final visible headline body"
          );
        }
      });

      test("foldDocumentationToSteps keeps the expected step markers visible and hides their bodies", async () => {
        const expectedStepRanges = getExpectedStepRanges(scenario);
        await placeCursorAtDocumentEnd(editor);
        await runFoldCommand("robotCompanion.foldDocumentationToSteps");
        await assertActiveProviderRanges(
          document,
          expectedStepRanges,
          "step fold should expose first-level and nested step body ranges through the provider"
        );
        await assertCursorJumpSequence(
          editor,
          scenario.firstLevelCursorJumps,
          "step fold"
        );
      });

      test("foldDocumentationToSteps clears an existing owner fold before applying documentation folds", async () => {
        const expectedStepRanges = getExpectedStepRanges(scenario);
        await createOwnerFold(editor, scenario.ownerLine);
        await placeCursorAtDocumentEnd(editor);
        await runFoldCommand("robotCompanion.foldDocumentationToSteps");
        await assertActiveProviderRanges(
          document,
          expectedStepRanges,
          "step fold after clearing owner fold should expose first-level and nested step body ranges"
        );
        await waitForCursorDownResult(
          editor,
          scenario.ownerLine,
          scenario.ownerLine + 1,
          "owner line should no longer stay collapsed after step folding"
        );
        await assertCursorJumpSequence(
          editor,
          scenario.firstLevelCursorJumps,
          "step fold after clearing owner fold"
        );
      });

      test("unfoldDocumentation restores line-by-line cursor movement", async () => {
        await placeCursorAtDocumentEnd(editor);
        await runFoldCommand("robotCompanion.foldDocumentationToHeadlines");

        await runFoldCommand("robotCompanion.unfoldDocumentation");
        await sleep(250);

        const unfoldedProviderRanges = await getActiveProviderRanges(document);
        assert(
          unfoldedProviderRanges.length > scenario.expectedBodyRanges.headline.length,
          "unfold should restore the full provider range set instead of leaving exact headline mode active"
        );

        const unfoldedProbeLines = Array.from(
          new Set(
            [
              ...scenario.headlineCursorJumps.map((jump) => jump.from),
              ...scenario.firstLevelCursorJumps.map((jump) => jump.from),
              ...scenario.secondLevelCursorJumps.map((jump) => jump.from)
            ].filter((line) => Number.isInteger(line))
          )
        );

        for (const line of unfoldedProbeLines) {
          await waitForCursorDownResult(
            editor,
            line,
            line + 1,
            `line ${line + 1} should move to the next physical line after unfold`
          );
        }
      });

      test("preview-targeted folding commands work even when a non-robot editor is active", async () => {
        await placeCursorAtDocumentEnd(editor);
        editor = await runPreviewFoldCommand("robotCompanion.foldDocumentationToHeadlines", document);
        await assertActiveProviderRanges(
          document,
          scenario.expectedBodyRanges.headline,
          "preview headline fold should expose only headline body ranges through the provider"
        );
        await assertCursorJumpSequence(editor, scenario.headlineCursorJumps, "preview headline fold");
        if (scenario.terminalHeadlineCursorExpectation) {
          await waitForCursorDownResult(
            editor,
            scenario.terminalHeadlineCursorExpectation.from,
            scenario.terminalHeadlineCursorExpectation.to,
            "preview headline fold should also collapse the final visible headline body"
          );
        }

        await placeCursorAtDocumentEnd(editor);
        editor = await runPreviewFoldCommand("robotCompanion.foldDocumentationToSteps", document);
        await assertActiveProviderRanges(
          document,
          getExpectedStepRanges(scenario),
          "preview step fold should expose first-level and nested step body ranges through the provider"
        );
        await assertCursorJumpSequence(editor, scenario.firstLevelCursorJumps, "preview step fold");

        await placeCursorAtDocumentEnd(editor);
        editor = await runPreviewFoldCommand("robotCompanion.unfoldDocumentation", document);
        await sleep(250);
        const previewUnfoldRanges = await getActiveProviderRanges(document);
        assert(
          previewUnfoldRanges.length > scenario.expectedBodyRanges.headline.length,
          "preview unfold should restore the default provider ranges"
        );
        await waitForCursorDownResult(
          editor,
          scenario.headlineCursorJumps[0].from,
          scenario.headlineCursorJumps[0].from + 1,
          "preview unfold should restore line-by-line movement"
        );
      });

      if (scenario.fixtureName === "folding-regression-adjustment.robot") {
        test("preview-targeted folding stays stable across repeated clicks", async () => {
          const repeatedPreviewChecks = [
            {
              command: "robotCompanion.foldDocumentationToHeadlines",
              expectedRanges: scenario.expectedBodyRanges.headline,
              jumps: scenario.headlineCursorJumps,
              terminalExpectation: scenario.terminalHeadlineCursorExpectation
            },
            {
              command: "robotCompanion.unfoldDocumentation",
              expectedRanges: null
            },
            {
              command: "robotCompanion.foldDocumentationToHeadlines",
              expectedRanges: scenario.expectedBodyRanges.headline,
              jumps: scenario.headlineCursorJumps,
              terminalExpectation: scenario.terminalHeadlineCursorExpectation
            },
            {
              command: "robotCompanion.foldDocumentationToSteps",
              expectedRanges: getExpectedStepRanges(scenario),
              jumps: scenario.firstLevelCursorJumps
            },
            {
              command: "robotCompanion.foldDocumentationToHeadlines",
              expectedRanges: scenario.expectedBodyRanges.headline,
              jumps: scenario.headlineCursorJumps,
              terminalExpectation: scenario.terminalHeadlineCursorExpectation
            }
          ];

          for (const step of repeatedPreviewChecks) {
            await placeCursorAtDocumentEnd(editor);
            editor = await runPreviewFoldCommand(step.command, document);

            if (step.expectedRanges) {
              await assertActiveProviderRanges(
                document,
                step.expectedRanges,
                `${step.command} should expose the expected repeated preview provider ranges`
              );
            } else {
              const providerRanges = await getActiveProviderRanges(document);
              assert(
                providerRanges.length > scenario.expectedBodyRanges.headline.length,
                "repeated preview unfold should restore the default provider ranges"
              );
            }

            if (Array.isArray(step.jumps) && step.jumps.length > 0) {
              await assertCursorJumpSequence(editor, step.jumps, `${step.command} repeated preview fold`);
            }

            if (step.terminalExpectation) {
              await waitForCursorDownResult(
                editor,
                step.terminalExpectation.from,
                step.terminalExpectation.to,
                `${step.command} repeated preview fold should still collapse the final visible headline body`
              );
            }
          }
        });
      }

      if (Array.isArray(scenario.previewSourceJumpLines) && scenario.previewSourceJumpLines.length > 0) {
        test("preview render targets jump to the expected later source lines", async () => {
          const parser = new extensionTestApi.RobotDocumentationService();
          const parsed = parser.parse(document);
          assert(parsed.blocks.length > 0, `Expected parsed documentation blocks for ${scenario.fixtureName}.`);

          const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), parsed.blocks[0]);
          assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
          assert(!renderedHtml.includes("doc-fragment"), "preview HTML should stay a single markdown flow");
          const decodedTargets = decodeDocumentationRenderTargets(renderedHtml);
          const targetLinesInOrder = decodedTargets
            .map((target) => {
              try {
                const parsedTargetCommand = parseCommandUri(target.commandUri);
                return Number(parsedTargetCommand.args[1]);
              } catch {
                return Number.NaN;
              }
            })
            .filter((line) => Number.isInteger(line));
          const filteredTargetLines = targetLinesInOrder.filter((line) => scenario.previewSourceJumpLines.includes(line));

          assert.deepStrictEqual(
            filteredTargetLines,
            scenario.previewSourceJumpLines,
            `${scenario.fixtureName} should expose later preview source targets in the expected order`
          );

          for (const expectedLine of scenario.previewSourceJumpLines) {
            const target = decodedTargets.find((candidate) => {
              try {
                const parsedTargetCommand = parseCommandUri(candidate.commandUri);
                return Number(parsedTargetCommand.args[1]) === expectedLine;
              } catch {
                return false;
              }
            });
            assert(target, `Expected a preview target for line ${expectedLine + 1}.`);

            await openNonRobotEditor();
            await executeCommandUri(target.commandUri);
            await waitFor(
              async () =>
                vscode.window.activeTextEditor?.document?.uri.toString() === document.uri.toString() &&
                vscode.window.activeTextEditor.selection.active.line === expectedLine,
              `preview source target for line ${expectedLine + 1}`
            );
          }
        });
      }
    });
  }

  suite("mixed documentation and inline preview targets", () => {
    for (const scenario of MIXED_DOCUMENTATION_PREVIEW_SCENARIOS) {
      test(`${scenario.fixtureName} keeps top documentation targets aligned with later inline comments`, async () => {
        const document = documentsByFixtureName.get(scenario.fixtureName);
        assert(document, `Expected document for fixture ${scenario.fixtureName}.`);

        const parser = new extensionTestApi.RobotDocumentationService();
        const parsed = parser.parse(document);
        assert.strictEqual(parsed.blocks.length, 1, `Expected a single documentation block for ${scenario.fixtureName}.`);

        const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), parsed.blocks[0]);
        assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
        assert(!renderedHtml.includes("doc-fragment"), "preview HTML should stay a single markdown flow");

        const decodedTargets = decodeDocumentationRenderTargets(renderedHtml);
        const actualTargetLinesInOrder = decodedTargets
          .map((target) => {
            try {
              const parsedTargetCommand = parseCommandUri(target.commandUri);
              return parsedTargetCommand.command === "robotCompanion.openLocation"
                ? Number(parsedTargetCommand.args[1])
                : Number.NaN;
            } catch {
              return Number.NaN;
            }
          })
          .filter((line) => Number.isInteger(line));

        assert.deepStrictEqual(
          actualTargetLinesInOrder,
          scenario.expectedTargetLinesInOrder,
          `${scenario.fixtureName} should keep documentation and inline targets in the expected order`
        );

        for (const expectedLine of scenario.previewSourceJumpLines) {
          const target = decodedTargets.find((candidate) => {
            try {
              const parsedTargetCommand = parseCommandUri(candidate.commandUri);
              return (
                parsedTargetCommand.command === "robotCompanion.openLocation" &&
                Number(parsedTargetCommand.args[1]) === expectedLine
              );
            } catch {
              return false;
            }
          });
          assert(target, `Expected a preview target for line ${expectedLine + 1}.`);

          await openNonRobotEditor();
          await executeCommandUri(target.commandUri);
          await waitFor(
            async () =>
              vscode.window.activeTextEditor?.document?.uri.toString() === document.uri.toString() &&
              vscode.window.activeTextEditor.selection.active.line === expectedLine,
            `${scenario.fixtureName} preview source target for line ${expectedLine + 1}`
          );
        }
      });
    }
  });
});
