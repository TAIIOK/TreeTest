import type { ReactNode } from "react";

const TOKEN =
  /\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:public|private|protected|class|static|void|int|boolean|long|double|float|char|if|else|for|while|return|new|true|false|null)\b|\b\d+\b/g;

export function highlightLine(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const value = match[0];
    const kind = value.startsWith("//")
      ? "comment"
      : value.startsWith('"') || value.startsWith("'")
        ? "string"
        : /^\d/.test(value)
          ? "number"
          : "keyword";
    nodes.push(
      <span key={index} className={kind}>
        {value}
      </span>,
    );
    index += 1;
    last = start + value.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  if (nodes.length === 0) nodes.push("\u00a0");
  return nodes;
}
