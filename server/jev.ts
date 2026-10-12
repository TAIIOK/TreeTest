import { clickableTargets, describeFragment, fragmentKey, situationOf, type Span } from "@/server/exprs";
import { chooseNext } from "@/server/litellm";
import { lineText, numberSource } from "@/server/source";
import type { TraceStep } from "@/server/trace";

const MAX_STEPS = 80;

function instructionsFor(source: string, previous: TraceStep | undefined): string {
  const tail = " Do not choose the fragment that just executed. Choose done only after the last statement of main.";
  if (!previous) {
    return "Pick the first fragment of main. Statements run from top to bottom." + tail;
  }
  const name = `«${previous.text}»`;
  switch (situationOf(source, previous)) {
    case "for-init":
      return `The for initializer ${name} just ran. The loop condition is next, before the body.` + tail;
    case "for-condition":
      return `The loop condition ${name} just ran. If it is true, the body is next. If it is false, the statement after the loop is next. Do not choose done and do not choose the update before the body.`;
    case "for-update":
      return `The for update ${name} just ran. The loop condition is next, even if it is now false. Do not choose done and do not choose the body before that condition.`;
    case "for-body":
      return `The loop body statement ${name} just ran. If the body has another statement, continue it. Otherwise the update is next, not the condition and not the body again.` + tail;
    case "call":
      return `The call ${name} just ran. If this method is defined in this file, its body runs next, top to bottom. After that body returns, the next argument call is next, and only then the outer call.` + tail;
    case "method":
      return `Inside a method, ${name} just ran. If this method has another statement, choose it. If this was the return, go back to the caller: the next argument call if one remains, otherwise the outer call name. Do not enter the outer method before that call.` + tail;
    case "if":
      return `The condition ${name} just ran. Choose only the branch that executes, then the statement after the if.` + tail;
    default:
      return `The statement ${name} just ran. Continue main from top to bottom. On a call, arguments run left to right: the call, then its body, then the next argument, then the outer call. A for loop starts with its initializer, then its condition.` + tail;
  }
}

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
    const previous = steps[steps.length - 1];
    const stepCriteria = { ...criteria };
    const situation = previous ? situationOf(source, previous) : undefined;
    if (situation === "for-update" || situation === "for-condition") delete stepCriteria.done;
    const choice = await chooseNext({
      model,
      instructions: instructionsFor(source, previous),
      criteria: stepCriteria,
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
