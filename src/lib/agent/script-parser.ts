/**
 * Browser-agnostic YAML/JSON subset parser for script files — the parsing
 * half of the script engine (port of stealthy-auto-browse's
 * `script_runner.py`). Split out of `script-runner.ts` so callers that only
 * parse script text (e.g. the URL-loader registry) never pull in the
 * execution engine.
 *
 * The engine must accept script files without pulling a YAML dependency into
 * the extension bundle. This parser covers the block subset of YAML that
 * script files actually use: mappings, sequences (including `- key: value`
 * items), scalars, and comments. JSON is accepted wholesale (JSON is valid
 * YAML 1.2). Flow collections (`{...}`, `[...]` values), anchors/aliases, and
 * multi-document streams are NOT supported — scripts using them fail parsing.
 * The parsed output is validated separately (`script-validation.ts`).
 */

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** Strip a trailing ` # comment` (a `#` preceded by whitespace, outside quotes). */
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inSingle) {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

interface ParsedLine {
  indent: number;
  content: string;
}

function splitLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, "  ");
    const trimmed = expanded.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const content = stripInlineComment(trimmed);
    if (content === "") continue;
    out.push({ indent: indentOf(expanded), content });
  }
  return out;
}

/** Split `key: value` at the first unquoted `:` followed by space/EOL. */
function splitKeyValue(content: string): { key: string; value: string; hasValue: boolean } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inSingle) {
      if (c === "'") {
        if (content[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ":" && (i + 1 === content.length || content[i + 1] === " ")) {
      return {
        key: content.slice(0, i).trim(),
        value: content.slice(i + 1).trim(),
        hasValue: content.slice(i + 1).trim() !== "",
      };
    }
  }
  return null;
}

function parseScalar(value: string): unknown {
  const s = value.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\(["\\/bfnrt])/g, (_m, c: string) => {
        switch (c) {
          case "b": return "\b";
          case "f": return "\f";
          case "n": return "\n";
          case "r": return "\r";
          case "t": return "\t";
          default: return c;
        }
      });
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function parseBlock(lines: ParsedLine[], start: number, parentIndent: number): { node: unknown; next: number } {
  if (start >= lines.length) return { node: null, next: start };
  const indent = lines[start].indent;
  if (parentIndent >= 0 && indent <= parentIndent) return { node: null, next: start };
  if (lines[start].content === "-" || lines[start].content.startsWith("- ")) {
    return parseSequence(lines, start, indent);
  }
  const kv = splitKeyValue(lines[start].content);
  if (kv === null) return { node: parseScalar(lines[start].content), next: start + 1 };
  return parseMapping(lines, start, indent);
}

function parseMapping(lines: ParsedLine[], start: number, indent: number): { node: Record<string, unknown>; next: number } {
  const node: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error("Invalid script: unexpected indentation");
    }
    if (line.content === "-" || line.content.startsWith("- ")) {
      throw new Error("Invalid script: unexpected list item in a mapping");
    }
    const kv = splitKeyValue(line.content);
    if (kv === null) {
      throw new Error("Invalid script: expected key: value");
    }
    if (!kv.hasValue) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, indent);
        node[kv.key] = nested.node;
        i = nested.next;
      } else {
        node[kv.key] = null;
        i++;
      }
      continue;
    }
    node[kv.key] = parseScalar(kv.value);
    i++;
  }
  return { node, next: i };
}

function parseSequence(lines: ParsedLine[], start: number, indent: number): { node: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error("Invalid script: unexpected indentation");
    }
    if (line.content !== "-" && !line.content.startsWith("- ")) {
      throw new Error("Invalid script: expected a list item");
    }
    const itemRest = line.content === "-" ? "" : line.content.slice(2).trim();
    if (itemRest === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, indent);
        items.push(nested.node);
        i = nested.next;
      } else {
        items.push(null);
        i++;
      }
      continue;
    }
    const kv = splitKeyValue(itemRest);
    if (kv === null) {
      items.push(parseScalar(itemRest));
      i++;
      continue;
    }
    // `- key: value` — a mapping item; consume deeper lines as more keys.
    const item: Record<string, unknown> = {};
    if (!kv.hasValue) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, indent);
        item[kv.key] = nested.node;
        i = nested.next;
      } else {
        item[kv.key] = null;
        i++;
      }
    } else {
      item[kv.key] = parseScalar(kv.value);
      i++;
    }
    while (i < lines.length && lines[i].indent > indent) {
      const nested = parseMapping(lines, i, lines[i].indent);
      Object.assign(item, nested.node);
      i = nested.next;
    }
    items.push(item);
  }
  return { node: items, next: i };
}

/**
 * Parse YAML or JSON script text into script data (validated separately).
 * Returns `null` for empty / comment-only input.
 */
export function parseScriptYaml(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — fall through to the YAML-subset parser.
  }
  const lines = splitLines(text);
  if (lines.length === 0) return null;
  return parseBlock(lines, 0, -1).node;
}
