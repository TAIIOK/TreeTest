const MAX_LINES = 100;
const MAX_CHARS = 8_000;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function normalizeSource(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new InputError("Вставьте Java-код");
  }
  if (normalized.length > MAX_CHARS) {
    throw new InputError("Код слишком длинный");
  }
  const lineCount = normalized.split("\n").length;
  if (lineCount > MAX_LINES) {
    throw new InputError("Не больше 100 строк");
  }
  if (!/\bmain\s*\(/.test(normalized)) {
    throw new InputError("Нужен метод main");
  }
  return normalized;
}

export function numberSource(source: string): string {
  return source
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
}

export function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}
