import { expandLineSteps } from "@/server/exprs";
import { chooseNext } from "@/server/litellm";
import { lineText, numberSource } from "@/server/source";
import { allowsImmediateRepeat, isSkippableLine, type TraceStep } from "@/server/trace";

const MAX_STEPS = 80;

const INSTRUCTIONS = [
  "Which numbered source line executes next?",
  "Choose done only when main has finished.",
  "Include local variable declarations, even without an initializer.",
  "For if, choose the condition, then only the taken branch.",
  "For a for or while header, choose it again before each next body execution and once more when the loop exits.",
  "For a method defined in this file, choose the call line, then the lines inside that method, then continue after the call.",
  "Do not choose the same line as the immediately previous step unless that line is a for, while, or if header.",
].join(" ");

export async function traceJava(source: string, signal?: AbortSignal): Promise<TraceStep[]> {
  const model = process.env.JEV_MODEL || "nimble";
  const lines = source.split("\n");
  const candidates = lines.flatMap((text, index) => {
    if (isSkippableLine(text)) return [];
    return [{ line: index + 1, text: text.trim() }];
  });
  if (candidates.length === 0) {
    throw new Error("В коде нет исполняемых строк");
  }

  const criteria: Record<string, string> = { done: "execution has finished" };
  for (const candidate of candidates) {
    criteria[String(candidate.line)] = candidate.text;
  }

  const steps: { line: number }[] = [];
  const numbered = numberSource(source);

  for (let index = 0; index < MAX_STEPS; index += 1) {
    const history =
      steps.length === 0
        ? "No statement has executed yet."
        : steps
            .map((step, stepIndex) => `${stepIndex + 1}. line ${step.line}: ${lineText(source, step.line).trim()}`)
            .join("\n");
    const choice = await chooseNext({
      model,
      instructions: INSTRUCTIONS,
      criteria,
      signal,
      state: `Java program. Execution starts at main.\n${numbered}\n\nAlready executed, in order:\n${history}`,
    });

    if (choice === "done") {
      return finishTrace(source, steps);
    }

    const line = Number(choice);
    if (!criteria[choice] || !Number.isInteger(line)) {
      throw new Error(`JEV вернул неизвестную строку ${choice}`);
    }

    const previous = steps[steps.length - 1];
    if (previous && previous.line === line && !allowsImmediateRepeat(lineText(source, line), source)) {
      return finishTrace(source, steps);
    }

    steps.push({ line });
  }

  throw new Error("Трасса слишком длинная, упростите программу");
}

function finishTrace(source: string, lineSteps: { line: number }[]): TraceStep[] {
  const expanded = expandLineSteps(source, lineSteps);
  if (expanded.length === 0) throw new Error("Пустая трасса");
  return expanded;
}
