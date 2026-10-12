import { fragmentKey, type Span } from "@/server/exprs";
import { completeText } from "@/server/litellm";
import { numberSource } from "@/server/source";
import { parseSnippet } from "@/server/treesitter";

const MAX_FRAGMENTS = 40;

const SYSTEM = `You list clickable execution fragments in source code.
Reply with JSON only, no markdown.
Shape: {"language":"Rust","fragments":[{"line":6,"text":"let a = 2;","role":"statement"},{"line":7,"text":"square","role":"call"},{"line":2,"text":"n * n","role":"body","after":"square"}]}
language is the programming language name.
Copy text exactly from that line.
role is "call" for a call name, "body" for a statement inside a function that a call enters, or "statement" for a step of the entry point that is not a call.
For a body, set after to the call name that enters it.
If a line contains a call, list the call name and do not also list the whole line.
A plain assignment with no call is one statement. One clause of a loop header is its own fragment.
Example: "let a = 2;" is a statement. "let z = square(a);" yields only the call "square".
List fragments in source order, not execution order.
Skip blank lines, lone braces, imports, and signatures that do not run.
At most ${MAX_FRAGMENTS} fragments. Every text must occur on its line.`;

export async function proposeFragments(
  source: string,
  signal?: AbortSignal,
): Promise<{ language: string; targets: Span[]; hints: Record<string, string> }> {
  try {
    const parsed = await parseSnippet(source);
    if (parsed && parsed.targets.length > 0) return parsed;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  return proposeWithModel(source, signal);
}

async function proposeWithModel(
  source: string,
  signal?: AbortSignal,
): Promise<{ language: string; targets: Span[]; hints: Record<string, string> }> {
  const model = process.env.EXPLAIN_MODEL || "openrouter/openrouter/free";
  const text = await completeText({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: numberSource(source) },
    ],
    temperature: 0.1,
    maxTokens: 1200,
    reasoningEffort: "none",
    signal,
  });
  const parsed = parseProposal(text);
  const located = locateFragments(source, parsed.fragments);
  if (located.targets.length === 0) {
    throw new Error("Модель не нашла исполняемые фрагменты");
  }
  return { language: parsed.language, targets: located.targets, hints: located.hints };
}

type RawFragment = { line: number; text: string; role?: string; after?: string };

function parseProposal(text: string): { language: string; fragments: RawFragment[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Модель не вернула список фрагментов");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Модель не вернула список фрагментов");
  }
  if (!data || typeof data !== "object") throw new Error("Модель не вернула список фрагментов");
  const record = data as { language?: unknown; fragments?: unknown };
  const language = cleanLanguage(record.language);
  if (!Array.isArray(record.fragments)) throw new Error("Модель не вернула список фрагментов");
  const fragments = record.fragments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { line?: unknown; text?: unknown; role?: unknown; after?: unknown };
    const line = typeof row.line === "number" ? row.line : Number(row.line);
    const quote = typeof row.text === "string" ? row.text : "";
    if (!Number.isInteger(line) || line < 1 || !quote.trim()) return [];
    const role = row.role === "call" || row.role === "body" || row.role === "statement" ? row.role : undefined;
    const after = typeof row.after === "string" ? row.after.trim().slice(0, 40) : undefined;
    return [{ line, text: quote, role, after }];
  });
  return { language, fragments: fragments.slice(0, MAX_FRAGMENTS) };
}

function locateFragments(source: string, fragments: RawFragment[]): { targets: Span[]; hints: Record<string, string> } {
  const lines = source.split("\n");
  const used = new Map<number, number[]>();
  const targets: Span[] = [];
  const hints: Record<string, string> = {};
  for (const fragment of fragments) {
    const line = lines[fragment.line - 1];
    if (line === undefined) continue;
    const place = placeOnLine(line, fragment.text, used.get(fragment.line) ?? []);
    if (!place) continue;
    used.set(fragment.line, place.used);
    const text = line.slice(place.start, place.end);
    if (targets.some((target) => target.line === fragment.line && target.start === place.start && target.end === place.end)) {
      continue;
    }
    const span = { line: fragment.line, start: place.start, end: place.end, text };
    targets.push(span);
    const hint = hintFor(fragment);
    if (hint) hints[fragmentKey(span)] = hint;
  }
  return { targets, hints };
}

function hintFor(fragment: RawFragment): string | undefined {
  if (fragment.role === "call") return "call";
  if (fragment.role === "body") {
    return fragment.after
      ? `function body, runs only immediately after the call ${fragment.after}`
      : "function body, runs only immediately after its call";
  }
  if (fragment.role === "statement") return "statement in the entry point";
  return undefined;
}

function placeOnLine(line: string, quote: string, used: number[]): { start: number; end: number; used: number[] } | null {
  const needle = quote.trim();
  let from = 0;
  let seen = 0;
  while (from <= line.length) {
    const start = line.indexOf(needle, from);
    if (start < 0) return null;
    if (!used.includes(seen)) {
      return { start, end: start + needle.length, used: [...used, seen] };
    }
    seen += 1;
    from = start + 1;
  }
  return null;
}

function cleanLanguage(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const cleaned = text.replace(/[^\p{L}\p{N} .+#-]/gu, "").slice(0, 32);
  return cleaned || "код";
}
