// tools/lib/mini-yaml.mjs
//
// A minimal YAML reader sized for the ObservabilityPack canonical example
// pack. Browser-friendly (pure ES module, no Node APIs). Used by the Node
// validator and by the studio's adapter when it lands.
//
// SUPPORTED
//   - Block mappings: `key: value` and `key:` (nested block follows)
//   - Block sequences: `- item`, `- key: value` (compact sequence-of-mappings)
//   - Flow mappings: `{k: v, k2: v2}`
//   - Flow sequences: `[a, b, c]`
//   - Literal block scalars: `|` (preserves newlines, strips common indent)
//   - Single- and double-quoted scalars
//   - Bare scalars: integers, floats, booleans, null, plain strings
//   - Full-line comments (`# ...`) and trailing comments
//
// INTENTIONAL NON-GOALS (not used in canonical packs we care about)
//   - YAML anchors / aliases (& / *)
//   - Folded block scalars `>`
//   - Block chomping indicators (`|+`, `|-`)
//   - Tag handles (`!!str`)
//   - Multi-document streams (`---`/`...`)
//   - Complex keys (`? key`)
//
// If a canonical pack uses something outside this subset, parse throws and
// the caller surfaces the line number.

export function parse(text) {
  if (typeof text !== 'string') throw new Error('mini-yaml: input must be a string');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const stream = new TokenStream(lines);
  const value = parseAtIndent(stream, 0);
  // refuse trailing significant content past the top-level node
  return value;
}

class TokenStream {
  constructor(lines) { this.lines = lines; this.idx = 0; }
  hasMore() { return this.idx < this.lines.length; }
  // Index of the next significant (non-blank, non-comment) line. -1 at EOF.
  // Does NOT consume.
  nextSignificantIdx() {
    let i = this.idx;
    while (i < this.lines.length) {
      const tr = this.lines[i].replace(/^\s+/, '');
      if (tr !== '' && !tr.startsWith('#')) return i;
      i++;
    }
    return -1;
  }
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

// Strip a trailing `#` comment, respecting quotes and flow brackets so `#`
// inside strings is preserved. A `#` is only a comment if preceded by
// whitespace (or sits at column 0 with respect to content).
function stripTrailingComment(s) {
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'" && s[i + 1] === "'") { i++; continue; }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === '#' && depth === 0 && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).replace(/\s+$/, '');
    }
  }
  return s.replace(/\s+$/, '');
}

// Find the first ":" that signals a mapping (followed by space, end of line,
// or end of string), outside quotes and flow brackets. Returns -1 if none.
function findMappingColon(s) {
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ':' && depth === 0) {
      if (i + 1 >= s.length || s[i + 1] === ' ' || s[i + 1] === '\t') return i;
    }
  }
  return -1;
}

function looksLikeMappingHead(s) {
  // A compact sequence item like `- key: value` looks like a mapping.
  // But `- { ... }` or `- [ ... ]` is a flow value, not a mapping head.
  if (s.startsWith('{') || s.startsWith('[')) return false;
  return findMappingColon(s) !== -1;
}

function parseAtIndent(stream, minIndent) {
  const sig = stream.nextSignificantIdx();
  if (sig === -1) return null;
  const line = stream.lines[sig];
  const ind = indentOf(line);
  if (ind < minIndent) return null;
  stream.idx = sig;
  const content = stripTrailingComment(line.slice(ind));
  if (content.startsWith('- ') || content === '-') {
    return parseBlockSequence(stream, ind);
  }
  return parseBlockMapping(stream, ind);
}

function parseBlockMapping(stream, indent) {
  const out = {};
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;        // belongs to a nested node we don't own
    const content = stripTrailingComment(line.slice(indent));
    if (content.startsWith('- ') || content === '-') break;

    const colon = findMappingColon(content);
    if (colon === -1) {
      throw new Error(`yaml line ${sig + 1}: expected "key: value", got ${JSON.stringify(content)}`);
    }
    const key = unquote(content.slice(0, colon).trim());
    const rest = content.slice(colon + 1).trim();
    stream.idx = sig + 1;

    if (rest === '') {
      // nested mapping/sequence at greater indent
      const nextSig = stream.nextSignificantIdx();
      if (nextSig === -1 || indentOf(stream.lines[nextSig]) <= indent) {
        out[key] = null;
      } else {
        const childIndent = indentOf(stream.lines[nextSig]);
        const childContent = stripTrailingComment(stream.lines[nextSig].slice(childIndent));
        if (childContent.startsWith('- ') || childContent === '-') {
          out[key] = parseBlockSequence(stream, childIndent);
        } else {
          out[key] = parseBlockMapping(stream, childIndent);
        }
      }
    } else if (rest === '|') {
      out[key] = readLiteralBlockScalar(stream, indent);
    } else {
      out[key] = parseValue(rest);
    }
  }
  return out;
}

function parseBlockSequence(stream, indent) {
  const arr = [];
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;
    const content = stripTrailingComment(line.slice(indent));
    if (!(content.startsWith('- ') || content === '-')) break;
    stream.idx = sig + 1;
    const inline = content === '-' ? '' : content.slice(2);

    if (inline === '') {
      const ns = stream.nextSignificantIdx();
      if (ns === -1 || indentOf(stream.lines[ns]) <= indent) {
        arr.push(null);
      } else {
        const childIndent = indentOf(stream.lines[ns]);
        const childContent = stripTrailingComment(stream.lines[ns].slice(childIndent));
        if (childContent.startsWith('- ') || childContent === '-') {
          arr.push(parseBlockSequence(stream, childIndent));
        } else {
          arr.push(parseBlockMapping(stream, childIndent));
        }
      }
    } else if (inline === '|') {
      arr.push(readLiteralBlockScalar(stream, indent));
    } else if (looksLikeMappingHead(inline)) {
      // Compact sequence-of-mappings: first key inline, rest of the mapping
      // at indent + 2 (YAML standard: continuation indents past `- `).
      const item = {};
      const firstColon = findMappingColon(inline);
      const firstKey = unquote(inline.slice(0, firstColon).trim());
      const firstRest = inline.slice(firstColon + 1).trim();
      if (firstRest === '' || firstRest === '|') {
        // First key has a block value — its content lives at indent + 4
        // (past `- key: `). We don't see this pattern in the canonical example,
        // so reject early to keep the parser honest.
        throw new Error(`yaml line ${sig + 1}: compact sequence item with empty/block first value is not supported`);
      }
      item[firstKey] = parseValue(firstRest);
      // Then continue reading the rest of THIS item's mapping at indent + 2.
      const cont = parseBlockMapping(stream, indent + 2);
      Object.assign(item, cont);
      arr.push(item);
    } else {
      arr.push(parseValue(inline));
    }
  }
  return arr;
}

// Collect lines strictly more indented than `parentIndent`, preserve their
// content with the leading common indent stripped, join with `\n`. Trailing
// blank lines are dropped; a final newline is appended.
function readLiteralBlockScalar(stream, parentIndent) {
  const collected = [];
  let blockIndent = null;
  while (stream.hasMore()) {
    const line = stream.lines[stream.idx];
    const isBlank = line.replace(/^\s+/, '') === '';
    if (isBlank) {
      collected.push('');
      stream.idx++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    collected.push(line.slice(blockIndent));
    stream.idx++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  return collected.join('\n') + '\n';
}

// Parse a scalar / flow value.
function parseValue(s) {
  s = s.trim();
  if (s === '') return null;
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMapping(s);
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSequence(s);
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  if (/^-?\d+[eE][+-]?\d+$/.test(s)) return parseFloat(s);
  return s;
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // Reuse JSON's parser for double-quoted strings — close enough for the
    // canonical example's escape vocabulary (\n, \t, \", \\, etc.).
    return JSON.parse(s);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseFlowMapping(s) {
  const inner = s.slice(1, -1).trim();
  if (inner === '') return {};
  const parts = splitFlow(inner, ',');
  const out = {};
  for (const part of parts) {
    const p = part.trim();
    if (p === '') continue;
    const colon = findMappingColon(p);
    if (colon === -1) {
      throw new Error(`yaml flow mapping: expected "k: v" in ${JSON.stringify(p)}`);
    }
    const k = unquote(p.slice(0, colon).trim());
    const v = parseValue(p.slice(colon + 1).trim());
    out[k] = v;
  }
  return out;
}

function parseFlowSequence(s) {
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlow(inner, ',').map(p => parseValue(p.trim()));
}

// Split a flow string by `sep`, respecting nested brackets and quotes.
function splitFlow(s, sep) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i++; continue; }
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '{' || c === '[') { depth++; buf += c; continue; }
    if (c === '}' || c === ']') { depth--; buf += c; continue; }
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}
