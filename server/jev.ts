import { clickableTargets, describeFragment, fragmentKey, type Span } from "@/server/exprs";
import { chooseNext } from "@/server/litellm";
import { lineText, numberSource } from "@/server/source";
import type { TraceStep } from "@/server/trace";

const MAX_STEPS = 80;

const INSTRUCTIONS = [
  "Pick the fragment Java executes next. Choose done only after the last statement of main.",
  "Run main from top to bottom. Do not skip a statement.",
  "Choose a call name before any fragment inside that method. Never enter a method before its call.",
  "Arguments go left to right: the call, then its whole body, then the next argument. Then the outer call, then its body.",
  "add(square(a), square(b)) is square(a), square body, square(b), square body, add, add body.",
  "Statements above a for loop run before its initializer.",
  "for (int i = 1; i <= 3; i++) { body } println is: initializer, condition, body, update, condition, body, update, condition, body, update, condition, println.",
  "The body runs only when the previous fragment was the condition. After the body, choose the update, not the body again.",
  "if: the condition, then only the taken branch.",
  "A fragment may be chosen again later. Do not choose the fragment that just executed.",
].join(" ");

export async function traceJava(source: string, signal?: AbortSignal): Promise<TraceStep[]> {
  const model = process.env.JEV_MODEL || "nimble";
  const targets = clickableTargets(source);
  if (targets.length === 0) {
    throw new Error("В коде нет исполняемых строк");
  }

  const byKey = new Map<string, Span>();
  const criteria: Record<string, string> = { done: "execution has finished" };
  for (const span of targets) {
    const key = fragmentKey(span);
    byKey.set(key, span);
    criteria[key] = describeFragment(lineText(source, span.line), span);
  }

  const steps: TraceStep[] = [];
  const catalog = targets.map((span) => criteria[fragmentKey(span)]).join("\n");
  let rejection = "";

  for (let index = 0; index < MAX_STEPS; index += 1) {
    const history =
      steps.length === 0
        ? "No fragment has executed yet."
        : steps
            .map((step, stepIndex) => `${stepIndex + 1}. ${describeFragment(lineText(source, step.line), step)}`)
            .join("\n");
    const choice = await chooseNext({
      model,
      instructions: INSTRUCTIONS,
      criteria,
      signal,
      state: `Java program. Execution starts at main.\n${numberSource(source)}\n\nFragments:\n${catalog}\n\nAlready executed, in order:\n${history}${rejection}`,
    });

    if (choice === "done") {
      return finish(steps);
    }

    const span = byKey.get(choice);
    if (!span) {
      throw new Error(`JEV вернул неизвестный фрагмент ${choice}`);
    }

    const previous = steps[steps.length - 1];
    if (previous && fragmentKey(previous) === choice) {
      if (rejection) return finish(steps);
      rejection = `\n\nThe last answer repeated ${describeFragment(lineText(source, previous.line), previous)}, which just executed. Choose a different fragment.`;
      continue;
    }

    rejection = "";
    steps.push(span);
  }

  throw new Error("Трасса слишком длинная, упростите программу");
}

function finish(steps: TraceStep[]): TraceStep[] {
  if (steps.length === 0) throw new Error("Пустая трасса");
  return steps;
}
