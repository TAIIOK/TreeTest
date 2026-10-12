import { isSkippableLine } from "@/server/trace";

export type Span = {
  line: number;
  start: number;
  end: number;
  text: string;
};

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "synchronized"]);

type CallNode = {
  nameStart: number;
  nameEnd: number;
  name: string;
  inner: CallNode[];
};

export function fragmentKey(span: Span): string {
  return `L${span.line}:${span.start}-${span.end}`;
}

export function describeFragment(line: string, span: Span): string {
  const shown = invocationText(line, span) ?? span.text;
  return `${fragmentKey(span)} ${shown}`;
}

export function clickableTargets(source: string): Span[] {
  const targets: Span[] = [];
  source.split("\n").forEach((text, index) => {
    if (isSkippableLine(text)) return;
    const line = index + 1;
    const header = parseForHeader(text);
    if (header) {
      const before = targets.length;
      for (const clause of [header.init, header.condition, header.update]) {
        if (!clause) continue;
        const calls = sourceOrder(parseRegion(text, clause.start, clause.end));
        if (calls.length === 0) targets.push({ line, start: clause.start, end: clause.end, text: clause.text });
        else for (const call of calls) targets.push({ line, ...call });
      }
      if (targets.length === before) targets.push(statementSpan(line, text));
      return;
    }
    const calls = sourceOrder(parseCalls(text));
    if (calls.length === 0) {
      targets.push(statementSpan(line, text));
      return;
    }
    for (const call of calls) targets.push({ line, ...call });
  });
  return targets;
}

function invocationText(line: string, span: Span): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(span.text)) return null;
  let cursor = span.end;
  while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
  if (line[cursor] !== "(") return null;
  const close = matchingParen(line, cursor, line.length);
  return line.slice(span.start, Math.min(line.length, close + 1)).replace(/\s+/g, " ");
}

type Clause = { start: number; end: number; text: string };

type ForHeader = {
  closeParen: number;
  init: Clause | null;
  condition: Clause | null;
  update: Clause | null;
};

function parseForHeader(line: string): ForHeader | null {
  const match = /\bfor\s*\(/.exec(line);
  if (!match || match.index === undefined) return null;
  const open = match.index + match[0].length - 1;
  const close = matchingParen(line, open, line.length);
  if (line[close] !== ")") return null;
  const parts = splitTop(line, open + 1, close, ";");
  if (parts.length !== 3) return null;
  const header = {
    closeParen: close,
    init: trimClause(line, parts[0].start, parts[0].end),
    condition: trimClause(line, parts[1].start, parts[1].end),
    update: trimClause(line, parts[2].start, parts[2].end),
  };
  if (!header.init && !header.condition && !header.update) return null;
  return header;
}

function trimClause(line: string, start: number, end: number): Clause | null {
  while (start < end && /\s/.test(line[start])) start += 1;
  while (end > start && /\s/.test(line[end - 1])) end -= 1;
  if (start >= end) return null;
  return { start, end, text: line.slice(start, end) };
}

function splitTop(line: string, from: number, to: number, separator: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let start = from;
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const char = line[index];
    if (char === '"' || char === "'") {
      index = skipString(line, index, to) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push({ start, end: index });
      start = index + 1;
    }
  }
  parts.push({ start, end: to });
  return parts;
}

function statementSpan(line: number, text: string): Span {
  const start = Math.max(0, text.search(/\S/));
  const end = text.trimEnd().length;
  return {
    line,
    start,
    end: Math.max(start, end),
    text: text.slice(start, Math.max(start, end)),
  };
}

function sourceOrder(calls: CallNode[]): { start: number; end: number; text: string }[] {
  const flat: { start: number; end: number; text: string }[] = [];
  const walk = (nodes: CallNode[]) => {
    for (const node of nodes) {
      flat.push({ start: node.nameStart, end: node.nameEnd, text: node.name });
      walk(node.inner);
    }
  };
  walk(calls);
  flat.sort((left, right) => left.start - right.start);
  return flat;
}

function parseCalls(line: string): CallNode[] {
  return parseRegion(line, 0, line.length);
}

function parseRegion(line: string, from: number, to: number): CallNode[] {
  const calls: CallNode[] = [];
  let index = from;
  while (index < to) {
    const char = line[index];
    if (char === '"' || char === "'") {
      index = skipString(line, index, to);
      continue;
    }
    if (char === "/" && line[index + 1] === "/") break;
    if (isIdentStart(char)) {
      const nameStart = index;
      index += 1;
      while (index < to && isIdentPart(line[index])) index += 1;
      const name = line.slice(nameStart, index);
      let cursor = index;
      while (cursor < to && /\s/.test(line[cursor])) cursor += 1;
      if (line[cursor] === "(") {
        const close = matchingParen(line, cursor, to);
        const inner = parseRegion(line, cursor + 1, close);
        if (CONTROL.has(name)) calls.push(...inner);
        else calls.push({ nameStart, nameEnd: index, name, inner });
        index = close + 1;
        continue;
      }
      continue;
    }
    if (char === "(") {
      const close = matchingParen(line, index, to);
      calls.push(...parseRegion(line, index + 1, close));
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return calls;
}

function matchingParen(line: string, openIndex: number, limit: number): number {
  let depth = 0;
  for (let index = openIndex; index < limit; index += 1) {
    const char = line[index];
    if (char === '"' || char === "'") {
      index = skipString(line, index, limit) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return Math.max(openIndex, limit - 1);
}

function skipString(line: string, start: number, limit: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < limit) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index += 1;
  }
  return limit;
}

function isIdentStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char));
}

function isIdentPart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}
