"use strict";

// Robot Framework's tag patterns, as `--include` and `--exclude` use them in
// RF 7.3.2 and 7.5: `NOT` binds loosest, then `OR`, then `AND` (or `&`);
// operators are case-sensitive; tags and patterns are compared caseless,
// without whitespace and underscores; `*`, `?` and `[...]` are Python glob
// patterns that must match the whole tag. Test Explorer uses this only to
// decide which selected tests a profile will run; Robot's own selection of the
// run stays authoritative. No VS Code dependency.

// Python's whitespace (str.split()), which RF removes when normalizing.
const PYTHON_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu;
// Full case folding, close to Python's str.casefold() (sharp s becomes ss).
const fold = text => text.toUpperCase().toLowerCase();
const normalize = text => fold(String(text).replace(PYTHON_SPACE, "")).replaceAll("_", "");

const SYNTAX = /[\\^$.*+?()[\]{}|/]/;
const escapeLiteral = character => SYNTAX.test(character) ? `\\${character}` : character;
const escapeInClass = character => /[\\\]^[-]/.test(character) ? `\\${character}` : character;

// fnmatch.translate (Python 3.11-3.13), producing an anchored JavaScript regex
// over code points: ranges that run backwards are dropped, `[!...]` negates,
// an unclosed `[` is literal.
function globToRegExp(pattern) {
  const pat = Array.from(pattern), n = pat.length, parts = [];
  let i = 0;
  while (i < n) {
    const c = pat[i++];
    if (c === "*") {
      if (parts.at(-1) !== ".*") parts.push(".*");
    } else if (c === "?") {
      parts.push(".");
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) {
        parts.push("\\[");
        continue;
      }
      let chunks;
      if (!pat.slice(i, j).includes("-")) {
        chunks = [pat.slice(i, j)];
      } else {
        chunks = [];
        let start = i, k = pat[i] === "!" ? i + 2 : i + 1;
        for (;;) {
          k = pat.indexOf("-", k);
          if (k < 0 || k >= j) break;
          chunks.push(pat.slice(start, k));
          start = k + 1;
          k += 3;
        }
        const chunk = pat.slice(start, j);
        if (chunk.length) chunks.push(chunk);
        else chunks[chunks.length - 1] = [...chunks.at(-1), "-"];
        for (let k2 = chunks.length - 1; k2 > 0; k2--) {
          if (chunks[k2 - 1].at(-1).codePointAt(0) > chunks[k2][0].codePointAt(0)) {
            chunks[k2 - 1] = [...chunks[k2 - 1].slice(0, -1), ...chunks[k2].slice(1)];
            chunks.splice(k2, 1);
          }
        }
      }
      i = j + 1;
      const raw = chunks.flat();
      if (!raw.length) {
        parts.push("(?!)");
      } else if (raw.length === 1 && raw[0] === "!") {
        parts.push(".");
      } else {
        const negated = raw[0] === "!";
        if (negated) chunks[0] = chunks[0].slice(1);
        parts.push(`[${negated ? "^" : ""}${chunks.map(chunk => chunk.map(escapeInClass).join("")).join("-")}]`);
      }
    } else {
      parts.push(escapeLiteral(c));
    }
  }
  return new RegExp(`^(?:${parts.join("")})$`, "su");
}

function compile(pattern) {
  if (pattern.includes("NOT")) {
    const [first, ...rest] = ` ${pattern} `.split("NOT");
    const must = compile(first), mustNot = rest.map(compile);
    return {
      match: tags => (!must.truthy || must.match(tags)) && !mustNot.some(item => item.match(tags)),
      truthy: true
    };
  }
  if (pattern.includes("OR")) {
    const any = ` ${pattern} `.split("OR").map(compile);
    return { match: tags => any.some(item => item.match(tags)), truthy: true };
  }
  if (pattern.includes("&")) pattern = pattern.replaceAll("&", " AND ");
  if (pattern.includes("AND")) {
    const all = ` ${pattern} `.split("AND").map(compile);
    return { match: tags => all.every(item => item.match(tags)), truthy: true };
  }
  const normalized = normalize(pattern), regex = globToRegExp(normalized);
  return { match: tags => tags.some(tag => regex.test(tag)), truthy: normalized.length > 0 };
}

// RF's TagPatterns: patterns that normalize to the same text count once, and
// the empty pattern and `NONE` are ignored. Matches any pattern; none: false.
function tagPatterns(patterns = []) {
  const seen = new Set(), compiled = [];
  for (const pattern of patterns) {
    const key = normalize(pattern);
    if (!key || key === "none" || seen.has(key)) continue;
    seen.add(key);
    compiled.push(compile(String(pattern)));
  }
  return {
    size: compiled.length,
    match: tags => compiled.length > 0 && compiled.some(item => item.match(tags.map(normalize)))
  };
}

// True when Robot's --include/--exclude keep a test with these tags.
function selectedByTags({ include = [], exclude = [] } = {}, tags = []) {
  const included = tagPatterns(include), excluded = tagPatterns(exclude);
  if (included.size && !included.match(tags)) return false;
  return !(excluded.size && excluded.match(tags));
}

module.exports = { tagPatterns, selectedByTags, globToRegExp, normalizeTag: normalize };
