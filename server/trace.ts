export type TraceStep = {
  line: number;
  start: number;
  end: number;
  text: string;
};

export function isSkippableLine(line: string): boolean {
  const text = line.trim();
  if (!text || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) {
    return true;
  }
  if (/^(import|package)\b/.test(text)) return true;
  if (/^[{}();]+$/.test(text)) return true;
  if (/^}\s*else\b/.test(text) && !text.includes("(")) return true;
  if (/^else\b/.test(text) && !text.includes("(")) return true;
  if (/\b(class|interface|enum)\b/.test(text) && /^(public|private|protected)?\s*(abstract\s+|final\s+|static\s+)?(class|interface|enum)\b/.test(text)) {
    return true;
  }
  const looksLikeSignature =
    /^(public|private|protected|static|final|void|int|boolean|long|double|float|char|String)\b/.test(text) &&
    /\([^;]*\)\s*\{?\s*$/.test(text) &&
    !text.includes(";") &&
    !/^(if|for|while|switch|catch)\b/.test(text);
  return looksLikeSignature;
}
