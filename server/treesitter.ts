import { readFile } from "fs/promises";
import path from "path";
import type Parser from "web-tree-sitter";
import { fragmentKey, type Span } from "@/server/exprs";

type ParserCtor = typeof Parser;
type SyntaxNode = Parser.SyntaxNode;

const runtime = globalThis as unknown as {
  __treeSitterReady?: Promise<void>;
  __treeSitterParser?: ParserCtor;
  __treeSitterLanguages?: Map<LanguageId, Parser.Language>;
};

function parserCtor(): ParserCtor {
  if (runtime.__treeSitterParser) return runtime.__treeSitterParser;
  const builtin = process.getBuiltinModule("module") as typeof import("node:module");
  const nodeRequire = builtin.createRequire(`${process.cwd()}/package.json`);
  const resolved = nodeRequire.resolve("web-tree-sitter");
  delete nodeRequire.cache[resolved];
  const loaded = nodeRequire("web-tree-sitter") as ParserCtor & { default?: ParserCtor };
  const parser = typeof loaded.init === "function" ? loaded : loaded.default;
  if (!parser || typeof parser.init !== "function") throw new Error("tree-sitter не загрузился");
  runtime.__treeSitterParser = parser;
  return parser;
}

const MAX_FRAGMENTS = 60;

const IDENTIFIERS = new Set([
  "identifier",
  "simple_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_field_identifier",
]);

const CALLS = new Set(["call_expression", "call", "macro_invocation", "method_invocation"]);

const FUNCTIONS = new Set([
  "function_item",
  "function_declaration",
  "function_definition",
  "method_declaration",
  "method_definition",
  "method",
]);

const LOOPS = new Set([
  "for_statement",
  "for_expression",
  "while_statement",
  "while_expression",
  "loop_expression",
  "enhanced_for_statement",
]);

const IFS = new Set(["if_statement", "if_expression"]);

const CONTAINERS = new Set([
  "source_file",
  "program",
  "module",
  "translation_unit",
  "chunk",
  "block",
  "statement_block",
  "compound_statement",
  "class_body",
  "declaration_list",
  "function_body",
  "statements",
  "body_statement",
  "else_clause",
  "elif_clause",
  "else_if_clause",
]);

const STRUCTURAL = new Set([
  "class_declaration",
  "class_definition",
  "impl_item",
  "mod_item",
  "struct_item",
  "enum_item",
  "interface_declaration",
  "object_declaration",
  "namespace_declaration",
]);

const SKIP = new Set([
  "package_clause",
  "import_declaration",
  "import_spec",
  "import_statement",
  "import_from_statement",
  "use_declaration",
  "preproc_include",
  "preproc_def",
  "preproc_call",
  "using_declaration",
  "attribute_item",
  "inner_attribute_item",
  "extern_crate_declaration",
]);

type LanguageId =
  | "rust"
  | "go"
  | "python"
  | "javascript"
  | "typescript"
  | "tsx"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift"
  | "lua"
  | "zig"
  | "elixir"
  | "scala"
  | "dart"
  | "bash";

const LANGUAGES: { id: LanguageId; label: string; hints: RegExp[] }[] = [
  { id: "rust", label: "Rust", hints: [/\bfn\s+\w+/, /\blet\s+(mut\s+)?\w+/, /println!/, /\bimpl\s+/, /->/] },
  { id: "go", label: "Go", hints: [/^package\s+\w+/m, /\bfunc\s+\w+/, /:=/] },
  { id: "python", label: "Python", hints: [/^\s*def\s+\w+\s*\(/m, /^\s*elif\b/m, /\bprint\s*\(/] },
  { id: "typescript", label: "TypeScript", hints: [/\binterface\s+\w+/, /\btype\s+\w+\s*=/, /:\s*(string|number|boolean)\b/] },
  { id: "tsx", label: "TSX", hints: [/<\/\w+>/, /\binterface\s+\w+/] },
  { id: "javascript", label: "JavaScript", hints: [/\bfunction\s+\w+/, /\bconst\s+\w+/, /=>/, /console\./] },
  { id: "java", label: "Java", hints: [/\bpublic\s+class\b/, /\bSystem\.out/, /\bvoid\s+main\s*\(/] },
  { id: "cpp", label: "C++", hints: [/\bstd::/, /#include\s*<iostream>/, /\bcout\b/] },
  { id: "c", label: "C", hints: [/#include\s*</, /\bprintf\s*\(/, /\bint\s+main\s*\(/] },
  { id: "c_sharp", label: "C#", hints: [/\busing\s+System\b/, /\bnamespace\s+\w+/, /\bConsole\.Write/] },
  { id: "ruby", label: "Ruby", hints: [/^\s*end\s*$/m, /\bputs\b/, /\bdo\b/] },
  { id: "php", label: "PHP", hints: [/<\?php/, /\$\w+/] },
  { id: "kotlin", label: "Kotlin", hints: [/\bfun\s+\w+/, /\bval\s+\w+/, /\bprintln\s*\(/] },
  { id: "swift", label: "Swift", hints: [/\bfunc\s+\w+/, /\blet\s+\w+/, /\bprint\s*\(/] },
  { id: "lua", label: "Lua", hints: [/\blocal\s+function\b/, /\blocal\s+\w+/, /\bthen\b/] },
  { id: "zig", label: "Zig", hints: [/\bpub\s+fn\b/, /\bconst\s+std\b/] },
  { id: "elixir", label: "Elixir", hints: [/\bdefmodule\b/, /\bdef\s+\w+/] },
  { id: "scala", label: "Scala", hints: [/\bobject\s+\w+/, /\bdef\s+\w+/] },
  { id: "dart", label: "Dart", hints: [/\bvoid\s+main\s*\(/, /\bWidget\b/] },
  { id: "bash", label: "Bash", hints: [/^#!/, /\becho\b/, /\bfi\b/] },
];

type Context = {
  entry: boolean;
  inLoop: boolean;
  functionName: string | null;
};

type Piece = { node: SyntaxNode; role: string; bang: boolean; after: string | null };

const loaded = (runtime.__treeSitterLanguages ??= new Map<LanguageId, Parser.Language>());

export async function parseSnippet(source: string): Promise<{ language: string; targets: Span[]; hints: Record<string, string> } | null> {
  const ranked = LANGUAGES
    .map((language) => ({ language, score: language.hints.reduce((sum, hint) => sum + (hint.test(source) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  if (ranked.length === 0) return null;

  await initParser();
  let best: { score: number; ratio: number; parsed: { language: string; targets: Span[]; hints: Record<string, string> } } | null = null;
  for (const item of ranked) {
    const language = await loadLanguage(item.language.id);
    const parser = new (parserCtor())();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    const ratio = errorRatio(tree.rootNode);
    const pieces = ratio <= 0.2 ? extractPieces(tree.rootNode) : [];
    const parsed = pieces.length > 0 ? materialize(source, item.language.label, pieces) : null;
    parser.delete();
    tree.delete();
    if (!parsed || parsed.targets.length === 0) continue;
    if (!best || item.score > best.score || (item.score === best.score && ratio < best.ratio)) {
      best = { score: item.score, ratio, parsed };
    }
    if (ratio === 0 && item.score === ranked[0].score) break;
  }
  return best?.parsed ?? null;
}

async function initParser(): Promise<void> {
  runtime.__treeSitterReady ??= parserCtor().init({
    locateFile: () => path.join(process.cwd(), "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
  });
  await runtime.__treeSitterReady;
}

async function loadLanguage(id: LanguageId): Promise<Parser.Language> {
  const cached = loaded.get(id);
  if (cached) return cached;
  const bytes = await readFile(path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", `tree-sitter-${id}.wasm`));
  const language = await parserCtor().Language.load(bytes);
  loaded.set(id, language);
  return language;
}

function errorRatio(root: SyntaxNode): number {
  let named = 0;
  let errors = 0;
  const walk = (node: SyntaxNode) => {
    if (node.isNamed) named += 1;
    if (node.isError || node.isMissing || node.type === "ERROR") errors += 1;
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return errors / Math.max(named, 1);
}

function extractPieces(root: SyntaxNode): Piece[] {
  const pieces: Piece[] = [];
  const entries = entryNames(root);
  walk(root, { entry: true, inLoop: false, functionName: null }, entries, pieces);
  return pieces.slice(0, MAX_FRAGMENTS);
}

function entryNames(root: SyntaxNode): Set<string> {
  const names = root
    .descendantsOfType(Array.from(FUNCTIONS))
    .map((node) => functionName(node))
    .filter(Boolean);
  if (names.some((name) => isEntry(name))) return new Set(names.filter((name) => isEntry(name)));
  const called = new Set(collectCalls(root).map((call) => callName(call).text));
  const roots = names.filter((name) => !called.has(name));
  if (roots.length === 1) return new Set(roots);
  if (names.length === 1) return new Set(names);
  return new Set(roots.length > 0 ? [roots[roots.length - 1]] : []);
}

function walk(node: SyntaxNode, ctx: Context, entries: Set<string>, pieces: Piece[]): void {
  if (SKIP.has(node.type) || node.type.includes("comment")) return;
  if (FUNCTIONS.has(node.type)) {
    const name = functionName(node);
    const body = functionBody(node);
    if (body) walk(body, { entry: entries.has(name), inLoop: false, functionName: name || null }, entries, pieces);
    return;
  }
  if (LOOPS.has(node.type)) {
    emitLoop(node, ctx, entries, pieces);
    return;
  }
  if (IFS.has(node.type)) {
    emitIf(node, ctx, entries, pieces);
    return;
  }
  if (node.type === "expression_statement" && node.namedChildCount === 1) {
    const inner = node.firstNamedChild;
    if (inner && (LOOPS.has(inner.type) || IFS.has(inner.type))) {
      walk(inner, ctx, entries, pieces);
      return;
    }
  }
  if (STRUCTURAL.has(node.type)) {
    for (const child of node.namedChildren) {
      if (FUNCTIONS.has(child.type) || CONTAINERS.has(child.type) || STRUCTURAL.has(child.type) || child.type.endsWith("_body")) {
        walk(child, ctx, entries, pieces);
      }
    }
    return;
  }
  if (CONTAINERS.has(node.type)) {
    for (const child of node.namedChildren) walk(child, ctx, entries, pieces);
    return;
  }
  emitStatement(node, ctx, pieces);
}

function emitLoop(node: SyntaxNode, ctx: Context, entries: Set<string>, pieces: Piece[]): void {
  const range = node.namedChildren.find((child) => child.type === "range_clause");
  if (range) {
    const right = range.childForFieldName("right") ?? range.lastNamedChild;
    if (right) emitClause(right, "loop-iterator", ctx, pieces);
  } else {
    const clause = node.namedChildren.find((child) => child.type === "for_clause") ?? node;
    const init = field(clause, ["initializer", "init"]);
    const condition = field(clause, ["condition"]);
    const update = field(clause, ["update", "increment"]);
    const iterator = field(clause, ["value", "right"]);
    if (init) emitClause(init, "loop-init", ctx, pieces);
    if (iterator && !init) emitClause(iterator, "loop-iterator", ctx, pieces);
    if (condition) emitClause(condition, "loop-condition", ctx, pieces);
    if (!init && !condition && !update && !iterator) {
      const bare = clause.namedChildren.find((child) => !CONTAINERS.has(child.type) && child.type !== "for_clause");
      if (bare) emitClause(bare, "loop-condition", ctx, pieces);
    }
    if (update) emitClause(update, "loop-update", ctx, pieces);
  }
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => CONTAINERS.has(child.type));
  if (body) walk(body, { ...ctx, inLoop: true }, entries, pieces);
}

function emitIf(node: SyntaxNode, ctx: Context, entries: Set<string>, pieces: Piece[]): void {
  const condition = node.childForFieldName("condition");
  if (condition) emitClause(condition, "statement", ctx, pieces);
  const consequence = node.childForFieldName("consequence") ?? node.childForFieldName("body");
  if (consequence) walk(consequence, ctx, entries, pieces);
  const alternative = node.childForFieldName("alternative");
  if (alternative) walk(alternative, ctx, entries, pieces);
}

function emitStatement(node: SyntaxNode, ctx: Context, pieces: Piece[]): void {
  if (SKIP.has(node.type) || IDENTIFIERS.has(node.type) || node.type.includes("comment")) return;
  emitClause(node, "statement", ctx, pieces);
}

function emitClause(node: SyntaxNode, role: string, ctx: Context, pieces: Piece[]): void {
  const calls = collectCalls(node).sort((left, right) => left.startIndex - right.startIndex);
  if (calls.length > 0) {
    for (const call of calls) {
      pieces.push({
        node: callName(call),
        role: "call",
        bang: call.type === "macro_invocation",
        after: null,
      });
    }
    return;
  }
  const placed = place(ctx, role);
  pieces.push({ node, role: placed.role, bang: false, after: placed.after });
}

function place(ctx: Context, role: string): { role: string; after: string | null } {
  const after = ctx.functionName && !ctx.entry ? ctx.functionName : null;
  if (role === "statement" && ctx.inLoop) return { role: "loop-body", after };
  if (role === "statement" && after) return { role: "body", after };
  return { role, after };
}

function collectCalls(node: SyntaxNode, acc: SyntaxNode[] = []): SyntaxNode[] {
  if (CALLS.has(node.type)) acc.push(node);
  for (const child of node.namedChildren) {
    if (FUNCTIONS.has(child.type) || STRUCTURAL.has(child.type)) continue;
    collectCalls(child, acc);
  }
  return acc;
}

function callName(call: SyntaxNode): SyntaxNode {
  for (const name of ["function", "macro", "method", "name"]) {
    const child = call.childForFieldName(name);
    if (child) return lastIdentifier(child);
  }
  const ident = call.namedChildren.find((child) => IDENTIFIERS.has(child.type));
  return ident ?? call;
}

function lastIdentifier(node: SyntaxNode): SyntaxNode {
  if (IDENTIFIERS.has(node.type)) return node;
  const fieldNode = node.childForFieldName("field") || node.childForFieldName("property") || node.childForFieldName("name");
  if (fieldNode && IDENTIFIERS.has(fieldNode.type)) return fieldNode;
  let last: SyntaxNode | null = null;
  for (const child of node.namedChildren) {
    if (child.type.includes("argument")) continue;
    const found = lastIdentifier(child);
    if (IDENTIFIERS.has(found.type)) last = found;
  }
  return last ?? node;
}

function functionName(node: SyntaxNode): string {
  const named = node.childrenForFieldName("name").find((child) => IDENTIFIERS.has(child.type));
  if (named) return named.text;
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    const inner = declarator.childForFieldName("declarator") ?? declarator.namedChildren.find((child) => IDENTIFIERS.has(child.type));
    if (inner && IDENTIFIERS.has(inner.type)) return inner.text;
    const nested = inner?.namedChildren.find((child) => IDENTIFIERS.has(child.type));
    if (nested) return nested.text;
  }
  return node.namedChildren.find((child) => IDENTIFIERS.has(child.type))?.text ?? "";
}

function functionBody(node: SyntaxNode): SyntaxNode | null {
  return (
    node.childForFieldName("body") ??
    node.namedChildren.find((child) => CONTAINERS.has(child.type) || child.type.endsWith("_body") || child.type === "statements") ??
    null
  );
}

function field(node: SyntaxNode, names: string[]): SyntaxNode | null {
  for (const name of names) {
    const child = node.childForFieldName(name);
    if (child) return child;
  }
  return null;
}

function isEntry(name: string): boolean {
  return name === "main" || name === "Main";
}

function materialize(source: string, language: string, pieces: Piece[]): { language: string; targets: Span[]; hints: Record<string, string> } {
  const ascii = !/[\u0080-\uFFFF]/.test(source);
  const targets: Span[] = [];
  const hints: Record<string, string> = {};
  for (const piece of pieces) {
    const span = spanOf(source, piece.node, ascii, piece.bang);
    if (!span.text) continue;
    if (targets.some((target) => target.line === span.line && target.start === span.start && target.end === span.end)) continue;
    targets.push(span);
    hints[fragmentKey(span)] = hintFor(piece);
  }
  return { language, targets, hints };
}

function hintFor(piece: Piece): string {
  if (piece.role === "call") return "call";
  const fn = piece.after ? `function body, runs only immediately after the call ${piece.after}` : "";
  const loop =
    piece.role === "loop-init"
      ? "loop initializer, runs once before the condition"
      : piece.role === "loop-condition"
        ? "loop condition, checked before the body and again after the update"
        : piece.role === "loop-update"
          ? "loop update, runs after the body, then the condition is next"
          : piece.role === "loop-iterator"
            ? "loop iterator, evaluated before the body repeats"
            : piece.role === "loop-body"
              ? "loop body"
              : "";
  if (fn && loop) return `${fn}; ${loop}`;
  if (loop) return loop;
  if (fn) return fn;
  return "statement in the entry point";
}

function spanOf(source: string, node: SyntaxNode, ascii: boolean, bang: boolean): Span {
  let start = ascii ? node.startIndex : jsIndex(source, node.startIndex);
  let end = ascii ? node.endIndex : jsIndex(source, node.endIndex);
  while (start < end && /\s/.test(source[start] ?? "")) start += 1;
  while (end > start && /\s/.test(source[end - 1] ?? "")) end -= 1;
  if (bang && source[end] === "!") end += 1;
  const prefix = source.slice(0, start);
  const line = prefix.split("\n").length;
  const column = start - (prefix.lastIndexOf("\n") + 1);
  const text = source.slice(start, end);
  return { line, start: column, end: column + text.length, text };
}

function jsIndex(source: string, byte: number): number {
  if (byte <= 0) return 0;
  const buffer = Buffer.from(source, "utf8");
  return buffer.subarray(0, Math.min(byte, buffer.length)).toString("utf8").length;
}
