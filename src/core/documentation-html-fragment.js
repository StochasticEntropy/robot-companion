"use strict";

// Documentation HTML comes from the workspace (Markdown with raw HTML, Python docstrings) and is placed
// inside the extension's own page. The webview parses that page as one document, so a stray
// "</section>" or "</div>" in documentation would close the extension's documentation container and
// put the rest of the documentation outside it.
//
// balanceDocumentationHtmlFragment re-serialises one documentation fragment so that it is
// self-contained: every element it opens is closed inside the fragment, end tags without a matching
// open element are dropped, and every close is written out explicitly. It follows the HTML parsing
// rules that close elements implicitly (paragraphs, list items, table sections, foreign content), so
// the browser builds the same tree from the output that the balancer tracked, and the output never
// contains an end tag the browser could match outside the fragment. Comments, doctypes and the
// document-level tags (html, head, body, frameset, frame, template, select, plaintext) are dropped;
// raw-text elements are always closed. It is deterministic and has no dependencies.

const ASCII_WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]);

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

// Tags whose start and end tags are left out; their content is kept.
const DROPPED_TAGS = new Set(["html", "head", "body", "frameset", "frame", "template", "select", "plaintext"]);

const RAW_TEXT_ELEMENTS = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript", "script"]);
const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(["textarea", "title"]);

const SPECIAL_HTML_ELEMENTS = new Set([
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "base",
  "basefont",
  "bgsound",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "iframe",
  "img",
  "input",
  "keygen",
  "li",
  "link",
  "listing",
  "main",
  "marquee",
  "menu",
  "meta",
  "nav",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "p",
  "param",
  "plaintext",
  "pre",
  "script",
  "search",
  "section",
  "select",
  "source",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
  "wbr",
  "xmp"
]);

const DEFAULT_SCOPE_HTML = new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"]);
const MATHML_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);
const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
const FORMATTING_MARKERS = new Set(["applet", "object", "marquee", "template", "td", "th", "caption"]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CLOSES_PARAGRAPH = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "search",
  "section",
  "summary",
  "ul",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "listing",
  "form",
  "li",
  "dd",
  "dt",
  "table",
  "hr",
  "xmp"
]);
const BLOCK_END_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "button",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "listing",
  "main",
  "menu",
  "nav",
  "ol",
  "pre",
  "search",
  "section",
  "summary",
  "ul",
  "applet",
  "marquee",
  "object",
  "dd",
  "dt"
]);
const FORMATTING_ELEMENTS = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u"
]);
const IMPLIED_END_TAGS = new Set(["dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc"]);
const TABLE_STRUCTURE = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);
const TABLE_CONTEXT = new Set(["table", "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "colgroup"]);
const TABLE_SECTIONS = new Set(["tbody", "thead", "tfoot"]);
const FOREIGN_BREAKOUT = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var"
]);

// SVG and MathML elements with these names are left out: some parsers pick the insertion mode by
// tag name alone, so they could read them as the HTML table, select or frameset elements.
const DROPPED_FOREIGN_TAGS = new Set([
  "body",
  "caption",
  "colgroup",
  "frameset",
  "head",
  "html",
  "select",
  "table",
  "tbody",
  "td",
  "template",
  "tfoot",
  "th",
  "thead",
  "tr"
]);

const SAFE_TAG_NAME = /^[a-z][^\t\n\f\r />"'<=\u0000]*$/;
const SAFE_ATTRIBUTE_NAME = /^[^\t\n\f\r />"'<=\u0000-\u001f\u007f]+$/;

function toAsciiLowerCase(value) {
  return String(value).replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isAsciiAlpha(character) {
  return /^[A-Za-z]$/.test(character || "");
}

// Reads a start or end tag at source[start] === "<" the way the HTML tokenizer does. Returns undefined
// when the input ends inside the tag (the browser discards such a tag).
function readTag(source, start) {
  const length = source.length;
  let index = start + 1;
  let isEndTag = false;
  if (source[index] === "/") {
    isEndTag = true;
    index += 1;
  }
  let name = "";
  while (index < length && !ASCII_WHITESPACE.has(source[index]) && source[index] !== "/" && source[index] !== ">") {
    name += source[index];
    index += 1;
  }
  const attributes = [];
  const seenAttributeNames = new Set();
  let selfClosing = false;
  for (;;) {
    while (index < length && ASCII_WHITESPACE.has(source[index])) {
      index += 1;
    }
    if (index >= length) {
      return undefined;
    }
    if (source[index] === ">") {
      index += 1;
      break;
    }
    if (source[index] === "/") {
      index += 1;
      if (index >= length) {
        return undefined;
      }
      if (source[index] === ">") {
        selfClosing = true;
        index += 1;
        break;
      }
      continue;
    }
    let attributeName = source[index];
    index += 1;
    while (
      index < length &&
      !ASCII_WHITESPACE.has(source[index]) &&
      source[index] !== "/" &&
      source[index] !== ">" &&
      source[index] !== "="
    ) {
      attributeName += source[index];
      index += 1;
    }
    while (index < length && ASCII_WHITESPACE.has(source[index])) {
      index += 1;
    }
    if (index >= length) {
      return undefined;
    }
    let value = "";
    if (source[index] === "=") {
      index += 1;
      while (index < length && ASCII_WHITESPACE.has(source[index])) {
        index += 1;
      }
      if (index >= length) {
        return undefined;
      }
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, index + 1);
        if (close < 0) {
          return undefined;
        }
        value = source.slice(index + 1, close);
        index = close + 1;
      } else if (quote !== ">") {
        const valueStart = index;
        while (index < length && !ASCII_WHITESPACE.has(source[index]) && source[index] !== ">") {
          index += 1;
        }
        if (index >= length) {
          return undefined;
        }
        value = source.slice(valueStart, index);
      }
    }
    const normalizedAttributeName = toAsciiLowerCase(attributeName);
    if (!seenAttributeNames.has(normalizedAttributeName)) {
      seenAttributeNames.add(normalizedAttributeName);
      attributes.push([normalizedAttributeName, value]);
    }
  }
  return {
    end: index,
    isEndTag,
    name: toAsciiLowerCase(name),
    attributes,
    selfClosing
  };
}

function serializeStartTag(name, attributes) {
  const serializedAttributes = attributes
    .filter(([attributeName]) => SAFE_ATTRIBUTE_NAME.test(attributeName))
    .map(([attributeName, value]) => ` ${attributeName}="${String(value).replace(/"/g, "&quot;")}"`)
    .join("");
  return `<${name}${serializedAttributes}>`;
}

function escapeLessThan(text) {
  return String(text).replace(/</g, "&lt;");
}

function findRawTextEnd(source, from, name) {
  const pattern = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "ig");
  pattern.lastIndex = from;
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

function balanceDocumentationHtmlFragment(html) {
  const source = String(html || "");
  const length = source.length;
  const output = [];
  // Open elements of the fragment: { name, namespace, htmlIntegrationPoint }.
  const stack = [];
  let formOpen = false;

  const top = () => stack[stack.length - 1];
  const isHtml = (node, name) => Boolean(node) && node.namespace === "html" && (name === undefined || node.name === name);
  const isSpecial = (node) =>
    (node.namespace === "html" && SPECIAL_HTML_ELEMENTS.has(node.name)) ||
    (node.namespace === "math" && (MATHML_TEXT_INTEGRATION_POINTS.has(node.name) || node.name === "annotation-xml")) ||
    (node.namespace === "svg" && SVG_HTML_INTEGRATION_POINTS.has(node.name));
  const isScopeBoundary = (node, extraHtmlBoundaries) =>
    (node.namespace === "html" &&
      (DEFAULT_SCOPE_HTML.has(node.name) || (extraHtmlBoundaries && extraHtmlBoundaries.has(node.name)))) ||
    (node.namespace === "math" && (MATHML_TEXT_INTEGRATION_POINTS.has(node.name) || node.name === "annotation-xml")) ||
    (node.namespace === "svg" && SVG_HTML_INTEGRATION_POINTS.has(node.name));

  // Index of the nearest open HTML element accepted by `matches`, searching from the current node and
  // stopping at a scope boundary; -1 when there is none.
  const findInScope = (matches, extraHtmlBoundaries) => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const node = stack[index];
      if (node.namespace === "html" && matches(node.name)) {
        return index;
      }
      if (isScopeBoundary(node, extraHtmlBoundaries)) {
        return -1;
      }
    }
    return -1;
  };
  const findInTableScope = (matches) => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const node = stack[index];
      if (node.namespace === "html" && matches(node.name)) {
        return index;
      }
      if (node.namespace === "html" && (node.name === "table" || node.name === "html" || node.name === "template")) {
        return -1;
      }
    }
    return -1;
  };
  const LIST_ITEM_SCOPE = new Set(["ol", "ul"]);
  const BUTTON_SCOPE = new Set(["button"]);

  const closeCurrent = () => {
    const node = stack.pop();
    if (node.name === "form" && node.namespace === "html") {
      formOpen = false;
    }
    output.push(`</${node.name}>`);
  };
  // Closes elements one by one, so every end tag the browser sees names its current node.
  const closeDownTo = (index) => {
    while (stack.length > index) {
      closeCurrent();
    }
  };
  const closeParagraphInButtonScope = () => {
    const index = findInScope((name) => name === "p", BUTTON_SCOPE);
    if (index >= 0) {
      closeDownTo(index);
    }
  };
  const nearestTableContext = () => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].namespace === "html" && TABLE_CONTEXT.has(stack[index].name)) {
        return index;
      }
    }
    return -1;
  };
  const closeToNearest = (names) => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].namespace === "html" && names.has(stack[index].name)) {
        closeDownTo(index + 1);
        return;
      }
    }
  };
  const push = (name, attributes, namespace) => {
    output.push(serializeStartTag(name, attributes));
    let htmlIntegrationPoint = false;
    if (namespace === "svg" && SVG_HTML_INTEGRATION_POINTS.has(name)) {
      htmlIntegrationPoint = true;
    } else if (namespace === "math" && name === "annotation-xml") {
      const encoding = toAsciiLowerCase((attributes.find(([attributeName]) => attributeName === "encoding") || ["", ""])[1]);
      htmlIntegrationPoint = encoding === "text/html" || encoding === "application/xhtml+xml";
    }
    stack.push({ name, namespace, htmlIntegrationPoint });
    if (name === "form" && namespace === "html") {
      formOpen = true;
    }
  };
  const emitEmpty = (name, attributes) => {
    output.push(serializeStartTag(name, attributes));
    output.push(`</${name}>`);
  };

  // Start tags in a table context (table, caption, column group, table body, row, cell), following the
  // table insertion modes. Returns true when the tag has been handled.
  const handleTableStructureStart = (name, attributes) => {
    for (;;) {
      const contextIndex = nearestTableContext();
      if (contextIndex < 0) {
        return true;
      }
      const context = stack[contextIndex].name;
      if (context === "td" || context === "th" || context === "caption") {
        closeDownTo(contextIndex);
        continue;
      }
      if (context === "colgroup") {
        if (name === "col") {
          output.push(serializeStartTag("col", attributes));
          return true;
        }
        closeDownTo(contextIndex);
        continue;
      }
      if (context === "tr") {
        if (name === "td" || name === "th") {
          closeDownTo(contextIndex + 1);
          push(name, attributes, "html");
          return true;
        }
        closeDownTo(contextIndex);
        continue;
      }
      if (TABLE_SECTIONS.has(context)) {
        closeDownTo(contextIndex + 1);
        if (name === "tr") {
          push("tr", attributes, "html");
          return true;
        }
        if (name === "td" || name === "th") {
          push("tr", [], "html");
          push(name, attributes, "html");
          return true;
        }
        closeDownTo(contextIndex);
        continue;
      }
      // context === "table"
      closeDownTo(contextIndex + 1);
      if (name === "caption" || name === "colgroup" || TABLE_SECTIONS.has(name)) {
        push(name, attributes, "html");
        return true;
      }
      if (name === "col") {
        push("colgroup", [], "html");
        output.push(serializeStartTag("col", attributes));
        return true;
      }
      push("tbody", [], "html");
    }
  };

  const consumeRawText = (name, attributes, from) => {
    output.push(serializeStartTag(name, attributes));
    const endIndex = findRawTextEnd(source, from, name);
    let content;
    let next;
    if (endIndex < 0) {
      content = source.slice(from);
      next = length;
    } else {
      content = source.slice(from, endIndex);
      const endTag = readTag(source, endIndex);
      next = endTag ? endTag.end : length;
    }
    // A style element keeps its text; the CSP decides about it. Everything else cannot end early or
    // contain markup when the browser parses it differently (for example noscript without scripting).
    output.push(name === "style" ? content : escapeLessThan(content));
    output.push(`</${name}>`);
    return next;
  };

  const handleHtmlStartTag = (tag, from) => {
    let name = tag.name === "image" ? "img" : tag.name;
    const attributes = tag.attributes;
    if (DROPPED_TAGS.has(name)) {
      return from;
    }
    if (TABLE_STRUCTURE.has(name)) {
      handleTableStructureStart(name, attributes);
      return from;
    }
    const contextIndex = nearestTableContext();
    const tableContext = contextIndex >= 0 ? stack[contextIndex].name : "";
    if (tableContext === "colgroup") {
      closeDownTo(contextIndex);
      return handleHtmlStartTag(tag, from);
    }
    const inTableMode = tableContext === "table" || TABLE_SECTIONS.has(tableContext) || tableContext === "tr";
    if (name === "table" && inTableMode) {
      closeToNearest(new Set(["table"]));
      closeCurrent();
      return handleHtmlStartTag(tag, from);
    }
    if (name === "form") {
      if (formOpen) {
        return from;
      }
      if (inTableMode) {
        emitEmpty("form", attributes);
        return from;
      }
    }
    if (CLOSES_PARAGRAPH.has(name)) {
      closeParagraphInButtonScope();
    }
    if (HEADINGS.has(name) && isHtml(top()) && HEADINGS.has(top().name)) {
      closeCurrent();
    }
    if (name === "li" || name === "dd" || name === "dt") {
      const matches = name === "li" ? (candidate) => candidate === "li" : (candidate) => candidate === "dd" || candidate === "dt";
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const node = stack[index];
        if (node.namespace === "html" && matches(node.name)) {
          closeDownTo(index);
          break;
        }
        // "search" became special only recently; closing through it is what older parsers do, and an
        // explicit close is read the same way by every parser.
        if (isSpecial(node) && !(node.namespace === "html" && ["address", "div", "p", "search"].includes(node.name))) {
          break;
        }
      }
    }
    if (name === "button") {
      const index = findInScope((candidate) => candidate === "button");
      if (index >= 0) {
        closeDownTo(index);
      }
    }
    if (name === "a") {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const node = stack[index];
        if (node.namespace === "html" && FORMATTING_MARKERS.has(node.name)) {
          break;
        }
        if (isHtml(node, "a")) {
          closeDownTo(index);
          break;
        }
      }
    }
    if (name === "nobr") {
      const index = findInScope((candidate) => candidate === "nobr");
      if (index >= 0) {
        closeDownTo(index);
      }
    }
    if ((name === "option" || name === "optgroup") && isHtml(top(), "option")) {
      closeCurrent();
    }
    if (name === "rb" || name === "rtc" || name === "rp" || name === "rt") {
      if (findInScope((candidate) => candidate === "ruby") >= 0) {
        while (
          isHtml(top()) &&
          IMPLIED_END_TAGS.has(top().name) &&
          !((name === "rp" || name === "rt") && top().name === "rtc")
        ) {
          closeCurrent();
        }
      }
    }
    if (RAW_TEXT_ELEMENTS.has(name) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(name)) {
      return consumeRawText(name, attributes, from);
    }
    if (VOID_ELEMENTS.has(name)) {
      output.push(serializeStartTag(name, attributes));
      return from;
    }
    if (name === "svg" || name === "math") {
      if (tag.selfClosing) {
        emitEmpty(name, attributes);
      } else {
        push(name, attributes, name);
      }
      return from;
    }
    push(name, attributes, "html");
    return from;
  };

  const usesHtmlRulesForStartTag = (name) => {
    const node = top();
    if (!node || node.namespace === "html") {
      return true;
    }
    if (node.namespace === "math" && MATHML_TEXT_INTEGRATION_POINTS.has(node.name) && name !== "mglyph" && name !== "malignmark") {
      return true;
    }
    if (node.namespace === "math" && node.name === "annotation-xml" && name === "svg") {
      return true;
    }
    return node.htmlIntegrationPoint;
  };

  const handleStartTag = (tag, from) => {
    if (usesHtmlRulesForStartTag(tag.name)) {
      return handleHtmlStartTag(tag, from);
    }
    const breaksOut =
      FOREIGN_BREAKOUT.has(tag.name) ||
      (tag.name === "font" && tag.attributes.some(([attributeName]) => ["color", "face", "size"].includes(attributeName)));
    if (breaksOut) {
      while (stack.length > 0 && !usesHtmlRulesForStartTag(tag.name) && top().namespace !== "html") {
        closeCurrent();
      }
      return handleHtmlStartTag(tag, from);
    }
    if (DROPPED_FOREIGN_TAGS.has(tag.name)) {
      return from;
    }
    const namespace = top().namespace;
    if (tag.selfClosing) {
      emitEmpty(tag.name, tag.attributes);
    } else {
      push(tag.name, tag.attributes, namespace);
    }
    return from;
  };

  const findHtmlEndTagMatch = (name) => {
    if (HEADINGS.has(name)) {
      return findInScope((candidate) => HEADINGS.has(candidate));
    }
    if (name === "p") {
      return findInScope((candidate) => candidate === "p", BUTTON_SCOPE);
    }
    if (name === "li") {
      return findInScope((candidate) => candidate === "li", LIST_ITEM_SCOPE);
    }
    if (BLOCK_END_TAGS.has(name) || FORMATTING_ELEMENTS.has(name)) {
      return findInScope((candidate) => candidate === name);
    }
    if (name === "table" || TABLE_STRUCTURE.has(name)) {
      return name === "col" ? -1 : findInTableScope((candidate) => candidate === name);
    }
    if (DROPPED_TAGS.has(name) || name === "br") {
      return -1;
    }
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const node = stack[index];
      if (isHtml(node, name)) {
        return index;
      }
      if (isSpecial(node)) {
        return -1;
      }
    }
    return -1;
  };

  const handleEndTag = (tag) => {
    const name = tag.name;
    if (top() && top().namespace !== "html") {
      for (let index = stack.length - 1; index >= 0 && stack[index].namespace !== "html"; index -= 1) {
        if (stack[index].name === name) {
          closeDownTo(index);
          return;
        }
      }
    }
    const index = findHtmlEndTagMatch(name);
    if (index >= 0) {
      closeDownTo(index);
    }
  };

  const handleText = (text) => {
    if (!text) {
      return;
    }
    if (isHtml(top(), "colgroup") && /[^\t\n\f\r ]/.test(text)) {
      closeCurrent();
    }
    output.push(text);
  };

  let index = 0;
  while (index < length) {
    const lessThan = source.indexOf("<", index);
    if (lessThan < 0) {
      handleText(source.slice(index));
      break;
    }
    handleText(source.slice(index, lessThan));
    index = lessThan;
    const next = source[index + 1];

    if (source.startsWith("<!--", index)) {
      if (source.startsWith("<!-->", index)) {
        index += 5;
      } else if (source.startsWith("<!--->", index)) {
        index += 6;
      } else {
        const ends = [source.indexOf("-->", index + 4), source.indexOf("--!>", index + 4)].filter((value) => value >= 0);
        if (ends.length === 0) {
          index = length;
        } else {
          const end = Math.min(...ends);
          index = end + (source.startsWith("-->", end) ? 3 : 4);
        }
      }
      continue;
    }
    if (next === "!" || next === "?") {
      if (source.startsWith("<![CDATA[", index) && top() && top().namespace !== "html") {
        const close = source.indexOf("]]>", index + 9);
        const text = close < 0 ? source.slice(index + 9) : source.slice(index + 9, close);
        handleText(text.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
        index = close < 0 ? length : close + 3;
        continue;
      }
      const close = source.indexOf(">", index + 2);
      index = close < 0 ? length : close + 1;
      continue;
    }
    if (next === "/") {
      const afterSlash = source[index + 2];
      if (isAsciiAlpha(afterSlash)) {
        const tag = readTag(source, index);
        if (!tag) {
          index = length;
          continue;
        }
        index = tag.end;
        handleEndTag(tag);
        continue;
      }
      if (afterSlash === ">") {
        index += 3;
        continue;
      }
      if (afterSlash === undefined) {
        handleText("&lt;/");
        index = length;
        continue;
      }
      const close = source.indexOf(">", index + 2);
      index = close < 0 ? length : close + 1;
      continue;
    }
    if (!isAsciiAlpha(next)) {
      handleText("&lt;");
      index += 1;
      continue;
    }
    const tag = readTag(source, index);
    if (!tag) {
      index = length;
      continue;
    }
    if (!SAFE_TAG_NAME.test(tag.name)) {
      handleText(escapeLessThan(source.slice(index, tag.end)));
      index = tag.end;
      continue;
    }
    index = handleStartTag(tag, tag.end);
  }
  closeDownTo(0);
  return output.join("");
}

module.exports = {
  balanceDocumentationHtmlFragment
};
