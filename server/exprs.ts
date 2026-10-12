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

export function expandLineSteps(source: string, lineSteps: { line: number }[]): Span[] {
  const lines = source.split("\n");
  const loops: OpenLoop[] = [];
  const result: Span[] = [];

  for (const step of lineSteps) {
    const text = lines[step.line - 1] ?? "";
    while (loops.length > 0) {
      const top = loops[loops.length - 1];
      if (step.line === top.line || top.body.has(step.line)) break;
      const finished = loops.pop();
      if (finished?.sawBody) result.push(...forVisit(finished.line, finished.text, finished.header, false));
    }

    const header = parseForHeader(text);
    const top = loops[loops.length - 1];
    if (top && top.body.has(step.line)) top.sawBody = true;

    if (header && top && top.line === step.line) {
      result.push(...forVisit(step.line, text, header, false));
      top.sawBody = false;
      continue;
    }
    if (header && !loops.some((loop) => loop.line === step.line)) {
      result.push(...forVisit(step.line, text, header, true));
      loops.push({
        line: step.line,
        text,
        header,
        body: forBodyLines(lines, step.line, header.closeParen),
        sawBody: false,
      });
      continue;
    }

    result.push(...spansForVisit(step.line, text));
  }

  while (loops.length > 0) {
    const finished = loops.pop();
    if (finished?.sawBody) result.push(...forVisit(finished.line, finished.text, finished.header, false));
  }
  return result;
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

function spansForVisit(line: number, text: string): Span[] {
  const calls = executionOrder(parseCalls(text));
  if (calls.length === 0) return [statementSpan(line, text)];
  return calls.map((call) => ({ line, ...call }));
}

type Clause = { start: number; end: number; text: string };

type ForHeader = {
  closeParen: number;
  init: Clause | null;
  condition: Clause | null;
  update: Clause | null;
};

type OpenLoop = {
  line: number;
  text: string;
  header: ForHeader;
  body: Set<number>;
  sawBody: boolean;
};

function forVisit(line: number, text: string, header: ForHeader, first: boolean): Span[] {
  const clauses = first ? [header.init, header.condition] : [header.update, header.condition];
  return clauses.flatMap((clause) => clauseSpans(line, text, clause));
}

function clauseSpans(line: number, text: string, clause: Clause | null): Span[] {
  if (!clause) return [];
  const calls = executionOrder(parseRegion(text, clause.start, clause.end));
  if (calls.length === 0) return [{ line, start: clause.start, end: clause.end, text: clause.text }];
  return calls.map((call) => ({ line, ...call }));
}

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

function forBodyLines(lines: string[], forLine: number, closeParen: number): Set<number> {
  const body = new Set<number>();
  let lineIndex = forLine - 1;
  let column = closeParen + 1;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    while (column < line.length && /\s/.test(line[column])) column += 1;
    if (column < line.length && !(line[column] === "/" && line[column + 1] === "/")) break;
    lineIndex += 1;
    column = 0;
  }
  if (lineIndex >= lines.length) return body;
  if (lines[lineIndex][column] === "{") {
    const end = matchBrace(lines, lineIndex, column);
    for (let current = lineIndex; current <= end.line; current += 1) {
      if (current + 1 === forLine) continue;
      if (isSkippableLine(lines[current] ?? "")) continue;
      body.add(current + 1);
    }
    return body;
  }
  if (lineIndex + 1 !== forLine && !isSkippableLine(lines[lineIndex] ?? "")) body.add(lineIndex + 1);
  return body;
}

function matchBrace(lines: string[], startLine: number, startColumn: number): { line: number; column: number } {
  let depth = 0;
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    let index = lineIndex === startLine ? startColumn : 0;
    while (index < line.length) {
      const char = line[index];
      if (char === '"' || char === "'") {
        index = skipString(line, index, line.length);
        continue;
      }
      if (char === "/" && line[index + 1] === "/") break;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return { line: lineIndex, column: index };
      }
      index += 1;
    }
  }
  return { line: lines.length - 1, column: 0 };
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

function executionOrder(calls: CallNode[]): { start: number; end: number; text: string }[] {
  const ordered: { start: number; end: number; text: string }[] = [];
  for (const call of calls) {
    ordered.push(...executionOrder(call.inner));
    ordered.push({ start: call.nameStart, end: call.nameEnd, text: call.name });
  }
  return ordered;
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
