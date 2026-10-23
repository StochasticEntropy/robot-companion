"use strict";

// Presentation only: the native service's variable type/modifiers still belong to each
// identifier run, while TextMate can style Robot's variable delimiters independently.
// Call only after validating/reconstructing the backend result, and never cache this
// projected data as a backend delta base. Coordinates remain UTF-16 throughout.
function presentSemanticTokenData(data, legend, lines) {
  const output = [];
  let line = 0, column = 0, previousLine = 0, previousColumn = 0;
  function emit(start, length, type, modifiers) {
    if (!length) return;
    output.push(line - previousLine, line === previousLine ? start - previousColumn : start, length, type, modifiers);
    previousLine = line;
    previousColumn = start;
  }
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    column = data[index] ? data[index + 1] : column + data[index + 1];
    const length = data[index + 2], type = data[index + 3], modifiers = data[index + 4];
    const source = lines[line];
    const text = source?.slice(column, column + length);
    let escapes = 0;
    for (let before = column - 1; before >= 0 && source?.[before] === "\\"; before--) escapes++;
    // RF classifies FOR's separators as control tokens too. Their lexical scope is
    // more precise for presentation; keyword calls named IN still have function type.
    if (legend.tokenTypes[type] === "keyword" && /^IN(?: RANGE| ENUMERATE| ZIP)?$/.test(text)) continue;
    if (legend.tokenTypes[type] !== "variable" || text?.length !== length || escapes % 2 ||
        !/^[$@&%]\{/.test(text) || !text.endsWith("}")) {
      emit(column, length, type, modifiers);
      continue;
    }
    let start = 0;
    for (let offset = 0; offset < text.length; offset++) {
      if (text[offset] === "\\") { offset++; continue; }
      const opening = /[$@&%]/.test(text[offset]) && text[offset + 1] === "{";
      if (!opening && text[offset] !== "{" && text[offset] !== "}") continue;
      emit(column + start, offset - start, type, modifiers);
      if (opening) offset++;
      start = offset + 1;
    }
    emit(column + start, text.length - start, type, modifiers);
  }
  return Uint32Array.from(output);
}

module.exports = { presentSemanticTokenData };
