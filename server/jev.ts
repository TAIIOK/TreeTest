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
  return walkTrace(source, clickableTargets(source), signal, { kind: "java" });
}

export async function traceCreative(
  source: string,
  targets: Span[],
  language: string,
  hints: Record<string, string>,
  signal?: AbortSignal,
): Promise<TraceStep[]> {
  return walkTrace(source, targets, signal, { kind: "creative", language, hints });
}

function creativeInstructions(language: string, previous: TraceStep | undefined, hint?: string): string {
  const tail = " Do not choose the fragment that just executed. Choose done when the entry point has finished and nothing it called is still running.";
  if (!previous) {
    return `This is ${language}. Pick the first statement of the entry point. Do not enter a function body before its call.` + tail;
  }
  const name = `«${previous.text}»`;
  if (hint?.includes("loop initializer")) {
    return `This is ${language}. The loop initializer ${name} just ran. The loop condition or iterator is next, before the body.` + tail;
  }
  if (hint?.includes("loop condition")) {
    return `This is ${language}. The loop condition ${name} just ran. If it is true, the body is next. If it is false, the statement after the loop is next. Do not choose done and do not choose the update before the body.`;
  }
  if (hint?.includes("loop update")) {
    return `This is ${language}. The loop update ${name} just ran. The loop condition is next, even if it is now false. Do not choose done and do not choose the body before that condition.`;
  }
  if (hint?.includes("loop iterator")) {
    return `This is ${language}. The loop iterator ${name} just ran. The body is next. After the body, repeat while the iterator has another item, then continue after the loop.` + tail;
  }
  if (hint?.includes("loop body")) {
    return `This is ${language}. The loop body ${name} just ran. If the body has another statement, continue it. Otherwise the update is next, or the condition if this loop has no update.` + tail;
  }
  if (hint === "call") {
    return `This is ${language}. The call ${name} just executed. If a fragment is marked as the function body that runs immediately after this call, that body is next. If no body is marked for this call, continue the caller.` + tail;
  }
  if (hint?.includes("function body")) {
    return `This is ${language}. The function body ${name} just finished. Return to the caller and continue with the next statement after that call.` + tail;
  }
  return `This is ${language}. The statement ${name} just executed. Continue the entry point from top to bottom. Do not enter a function body before its call. A loop starts with its initializer or iterator, then its condition, and checks that condition again after the update.` + tail;
}

async function walkTrace(
  source: string,
  targets: Span[],
  signal: AbortSignal | undefined,
  mode: { kind: "java" } | { kind: "creative"; language: string; hints: Record<string, string> },
): Promise<TraceStep[]> {
  const model = process.env.JEV_MODEL || "nimble";
  if (targets.length === 0) {
    throw new Error("В коде нет исполняемых строк");
  }

  const byKey = new Map<string, Span>();
  const criteria: Record<string, string> = { done: "execution has finished" };
  for (const span of targets) {
    const key = fragmentKey(span);
    byKey.set(key, span);
    criteria[key] = described(source, span, mode.kind === "creative" ? mode.hints[key] : undefined);
  }

  const steps: TraceStep[] = [];
  const catalog = targets.map((span) => criteria[fragmentKey(span)]).join("\n");
  let rejection = "";

  for (let index = 0; index < MAX_STEPS; index += 1) {
    const history =
      steps.length === 0
        ? "No fragment has executed yet."
        : steps
            .map((step, stepIndex) => `${stepIndex + 1}. ${criteria[fragmentKey(step)]}`)
            .join("\n");
    const previous = steps[steps.length - 1];
    const stepCriteria = { ...criteria };
    const situation = previous && mode.kind === "java" ? situationOf(source, previous) : undefined;
    const previousHint = previous && mode.kind === "creative" ? mode.hints[fragmentKey(previous)] : undefined;
    if (situation === "for-update" || situation === "for-condition") delete stepCriteria.done;
    if (previousHint?.includes("loop condition") || previousHint?.includes("loop update")) delete stepCriteria.done;
    const intro =
      mode.kind === "java"
        ? "Java program. Execution starts at main."
        : `${mode.language} program. Execution starts at its entry point.`;
    const choice = await chooseNext({
      model,
      instructions:
        mode.kind === "java"
          ? instructionsFor(source, previous)
          : creativeInstructions(mode.language, previous, previous ? mode.hints[fragmentKey(previous)] : undefined),
      criteria: stepCriteria,
      signal,
      state: `${intro}\n${numberSource(source)}\n\nFragments:\n${catalog}\n\nAlready executed, in order:\n${history}${rejection}`,
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
      rejection = `\n\nThe last answer repeated ${criteria[choice]}, which just executed. Choose a different fragment.`;
      continue;
    }

    rejection = "";
    steps.push(span);
    if (mode.kind === "creative" && steps.filter((step) => fragmentKey(step) === choice).length >= 6) {
      return finish(steps);
    }
  }

  throw new Error("Трасса слишком длинная, упростите программу");
}

function described(source: string, span: Span, hint?: string): string {
  const text = describeFragment(lineText(source, span.line), span);
  if (!hint) return text;
  const space = text.indexOf(" ");
  return `${text.slice(0, space)} ${hint}: ${text.slice(space + 1)}`;
}

function finish(steps: TraceStep[]): TraceStep[] {
  if (steps.length === 0) throw new Error("Пустая трасса");
  return steps;
}
