const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const { balanceDocumentationHtmlFragment } = require("../src/core/documentation-html-fragment");

// Places a balanced fragment where the webviews place documentation: inside the extension's container,
// followed by more of the extension's own markup. DOMParser parses it as a whole HTML document.
const { window } = new JSDOM("<!DOCTYPE html>", { virtualConsole: new VirtualConsole() });
const domParser = new window.DOMParser();
function parsePage(fragmentHtml) {
  return domParser.parseFromString(
    `<!DOCTYPE html><html><head></head><body><div class="preview"><section id="doc-container">${fragmentHtml}</section><p id="after">after</p></div><div id="tail">tail</div></body></html>`,
    "text/html"
  );
}

// The page around the documentation is unchanged, so nothing in the fragment closed or left the
// container, and nothing the fragment opened continues after it.
function assertContained(document, label) {
  const body = document.body;
  const preview = document.querySelector("div.preview");
  const container = document.getElementById("doc-container");
  const after = document.getElementById("after");
  const tail = document.getElementById("tail");
  assert(container && after && tail && preview, `${label}: the extension's markup must survive`);
  assert.deepStrictEqual(
    Array.from(body.children).map((element) => element.className || element.id),
    ["preview", "tail"],
    `${label}: body children`
  );
  assert.strictEqual(preview.parentElement, body, `${label}: preview parent`);
  assert.deepStrictEqual(
    Array.from(preview.children).map((element) => element.id),
    ["doc-container", "after"],
    `${label}: preview children`
  );
  assert.strictEqual(after.innerHTML, "after", `${label}: the markup after the documentation must be untouched`);
  assert.strictEqual(tail.innerHTML, "tail", `${label}: the markup after the preview must be untouched`);
}

const RAW_TEXT = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript", "script", "textarea", "title"]);
const VOID = new Set([
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

// The tree the balancer meant: its output read as strictly nested tags.
function readIntendedTree(fragmentHtml) {
  const root = { name: "#root", children: [] };
  const stack = [{ node: root, namespace: "html" }];
  const pattern = /<(\/?)([^\s>/]+)[^>]*>/g;
  let match;
  while ((match = pattern.exec(fragmentHtml))) {
    const [, isEnd, rawName] = match;
    const name = rawName.toLowerCase();
    const parent = stack[stack.length - 1];
    if (isEnd) {
      assert.strictEqual(parent.node.name, name, `the balancer's end tag </${name}> must close its current element`);
      stack.pop();
      continue;
    }
    // <svg> and <math> start foreign content from HTML; inside foreign content they keep its namespace,
    // except an <svg> in a MathML annotation-xml.
    let namespace = parent.namespace;
    if (parent.namespace === "html" && (name === "svg" || name === "math")) {
      namespace = name;
    } else if (parent.namespace === "math" && parent.node.name === "annotation-xml" && name === "svg") {
      namespace = "svg";
    }
    const node = { name, children: [] };
    parent.node.children.push(node);
    if (namespace === "html" && VOID.has(name)) {
      continue;
    }
    if (namespace === "html" && RAW_TEXT.has(name)) {
      const end = fragmentHtml.indexOf(`</${name}>`, pattern.lastIndex);
      assert(end >= 0, `raw text element ${name} must be closed`);
      pattern.lastIndex = end + name.length + 3;
      continue;
    }
    // HTML inside an SVG/MathML integration point is HTML again.
    const htmlInside =
      (namespace === "svg" && ["foreignobject", "desc", "title"].includes(name)) ||
      (namespace === "math" && ["mi", "mo", "mn", "ms", "mtext"].includes(name)) ||
      (namespace === "math" && name === "annotation-xml" && /encoding="(text\/html|application\/xhtml\+xml)"/i.test(match[0]));
    stack.push({ node, namespace: htmlInside ? "html" : namespace });
  }
  assert.strictEqual(stack.length, 1, "every element the balancer opened must be closed");
  return root;
}

function readParsedTree(element) {
  return {
    name: element.localName.toLowerCase(),
    children: Array.from(element.children).map(readParsedTree)
  };
}

function assertBrowserBuildsIntendedTree(fragmentHtml, label) {
  const document = parsePage(fragmentHtml);
  assertContained(document, label);
  // Tables move misplaced content in front of the table (foster parenting); the content stays inside
  // the container, which assertContained checks, but the order differs from the tag order.
  if (/<table/.test(fragmentHtml)) {
    return;
  }
  const intended = readIntendedTree(fragmentHtml).children;
  const parsed = readParsedTree(document.getElementById("doc-container")).children;
  assert.deepStrictEqual(parsed, intended, `${label}: the browser must build the tree the balancer tracked`);
}

function check(input, label = JSON.stringify(input).slice(0, 120)) {
  const balanced = balanceDocumentationHtmlFragment(input);
  assertBrowserBuildsIntendedTree(balanced, label);
  assert.strictEqual(balanceDocumentationHtmlFragment(balanced), balanced, `${label}: balancing must be idempotent`);
  return balanced;
}

const SVG = '<svg width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="red"/></svg>';

// The hostile inputs of MIS-138 D2, and the stray closing tags of D1.
const NAMED_CASES = [
  SVG,
  `</section>${SVG}`,
  `</section></div></div>${SVG}`,
  `</section></div></div></div></div></main></body></html>${SVG}<p>after</p>`,
  "<style>body * { display: none !important; }</style>",
  '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647">overlay</div>',
  '<p style="color:red">styled</p></section></div>',
  '<span class="doc-color-span doc-color-custom" style="color:#0f766e">custom</span>',
  '<span class="robot-render-line robot-arrow-line" style="--robot-arrow-indent:2ch">x</span>',
  "<p>[[RDP_INDENT_2]]-> arrow</p>",
  "<ul><li>a<div><li>b</div></li></ul></div>",
  "<dl><dd>x<div><dt>y</div></dl></div>",
  "<button>a<div><button>b</div></button></div>",
  "<a href=\"x\">1<div><a href=\"y\">2</div></a></div>",
  "<b><p>bold</b>after</p></div>",
  "<table><td>x<div>y<tr><td>z</table></div></div>",
  "<table><div>foster<td>cell</div></table></section>",
  "<table><table><tr><td>x</td></tr></table></div>",
  "<table><caption>c<td>d</caption></table></div>",
  "<table><colgroup>text<col></colgroup><tr><td>x</td></tr></table>",
  "<form><div><form>x</form></div></form></div>",
  "<svg><foreignObject><div></foreignObject></svg></div></section>",
  "<svg><p>breakout</p><rect/></svg></div>",
  "<math><mi><div>x</div></mi><annotation-xml encoding=\"text/html\"><div></div></annotation-xml></math></div>",
  "<textarea></section></div><svg></textarea>",
  "<script>window.x = '</section>'</script></div>",
  "<script><!--<script></script></section>",
  "<noscript></section><div></noscript>",
  "<xmp></section></xmp>",
  "<title></div></title>",
  "<!-- </section> --></div><!-- unterminated </section>",
  "<!DOCTYPE html><html><body></body></html></section>",
  "<template></section></template></div>",
  "<plaintext></section>",
  "<select><option>a</section><div>b</div></select>",
  "<ruby>a<rb>b<rt>c<rtc>d<rp>e</ruby></div>",
  "<h1>a<h2>b</h1>c</h2></div>",
  "<nobr>a<nobr>b</div>",
  "<object><div></object></div>",
  "<li<link>nk rel=\"stylesheet\" href=\"x\">",
  "<o:p>word</o:p></section>",
  "<div",
  "<div title='a>b'>x</div></section>",
  "</>< 3 </ 3> <? pi ?> <![CDATA[ x ]]> <svg><![CDATA[</section>]]></svg>",
  "<image src=\"x.png\"><svg><image href=\"y.png\"/></svg>"
];

for (const input of NAMED_CASES) {
  check(input);
}

// D1: whatever the documentation does, its elements end up inside the container.
for (const strays of ["</section>", "</div>", "</section></div></div>", "</div>".repeat(25), "</section>".repeat(25)]) {
  const balanced = check(`${strays}<p id="marker">doc</p>${SVG}`);
  const document = parsePage(balanced);
  const container = document.getElementById("doc-container");
  assert(container.contains(document.getElementById("marker")), `${strays}: documentation must stay inside its container`);
  assert(container.contains(document.querySelector("svg")), `${strays}: the SVG must stay inside its container`);
  assert.strictEqual(document.querySelectorAll("svg").length, 1);
}

// Generated markup is left as it was.
assert.strictEqual(
  balanceDocumentationHtmlFragment(
    '<p><span class="doc-color-span doc-color-custom" style="color:#0f766e">custom</span> and <a href="command:robotCompanion.openLocation?%5B%5D">jump</a></p>\n<pre><code class="language-text">x &lt; y\n</code></pre>\n'
  ),
  '<p><span class="doc-color-span doc-color-custom" style="color:#0f766e">custom</span> and <a href="command:robotCompanion.openLocation?%5B%5D">jump</a></p>\n<pre><code class="language-text">x &lt; y\n</code></pre>\n'
);

// Deterministic fuzzing: random tag soup must always come out balanced and contained.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_NAMES = [
  "div", "section", "main", "p", "span", "ul", "ol", "li", "dl", "dd", "dt", "table", "caption", "colgroup", "col",
  "tbody", "thead", "tr", "td", "th", "a", "b", "i", "em", "font", "nobr", "button", "form", "select", "option",
  "optgroup", "svg", "math", "mi", "mtext", "annotation-xml", "foreignObject", "desc", "title", "rect", "g", "h1",
  "h3", "pre", "textarea", "style", "script", "xmp", "noscript", "iframe", "template", "body", "html", "head",
  "frameset", "plaintext", "ruby", "rb", "rt", "rp", "rtc", "img", "image", "br", "hr", "input", "object", "marquee",
  "applet", "center", "custom-el", "o:p", "label", "details", "summary", "dialog", "search", "listing"
];
const FUZZ_SNIPPETS = ["text", " ", "<", "&lt;", "<!--", "-->", "<!-- c -->", "<!doctype html>", "<![CDATA[x]]>", "</>", "<?x?>", ">"];

function randomFragment(random) {
  const pick = (values) => values[Math.floor(random() * values.length)];
  const parts = [];
  const count = 1 + Math.floor(random() * 30);
  for (let index = 0; index < count; index += 1) {
    const roll = random();
    const name = pick(FUZZ_NAMES);
    if (roll < 0.45) {
      const attributes = random() < 0.3 ? ` id="x${index}"` : random() < 0.1 ? ' encoding="text/html" color="red"' : "";
      parts.push(`<${name}${attributes}${random() < 0.1 ? "/" : ""}>`);
    } else if (roll < 0.8) {
      parts.push(`</${name}>`);
    } else {
      parts.push(pick(FUZZ_SNIPPETS));
    }
  }
  if (random() < 0.05) {
    parts.push("<div title=\"unterminated");
  }
  return parts.join("");
}

const random = createRandom(138);
const FUZZ_ITERATIONS = 2500;
for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration += 1) {
  const input = randomFragment(random);
  check(input, `fuzz #${iteration} ${JSON.stringify(input)}`);
}

console.log(
  `documentation-html-fragment: ${NAMED_CASES.length} named cases, 5 stray-tag cases and ${FUZZ_ITERATIONS} fuzzed fragments passed.`
);
