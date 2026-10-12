import type { ClickFailure, ClickSuccess, PublicSession, Span, StepMark } from "@/lib/types";
import { clickableTargets } from "@/server/exprs";
import { traceJava } from "@/server/jev";
import { InputError, normalizeSource } from "@/server/source";
import { findTask } from "@/server/tasks";
import type { TraceStep } from "@/server/trace";

type Mistake = {
  token: string;
  clickedLine: number;
  clickedText: string;
  correctLine: number;
  correctText: string;
};

type Session = {
  id: string;
  source: string;
  steps: TraceStep[];
  targets: Span[];
  cursor: number;
  marks: StepMark[];
  taskTitle: string;
  mistake?: Mistake;
};

const globalStore = globalThis as unknown as { __traceSessionsV6?: Map<string, Session> };
const sessions = (globalStore.__traceSessionsV6 ??= new Map<string, Session>());

export class SessionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SessionError";
    this.status = status;
  }
}

export async function createSession(input: { taskId?: string; source?: string }): Promise<PublicSession> {
  let source: string;
  let taskTitle = "Свой код";

  if (input.taskId) {
    const task = findTask(input.taskId);
    if (!task) throw new SessionError(404, "Задача не найдена");
    source = task.source;
    taskTitle = task.title;
  } else if (typeof input.source === "string") {
    try {
      source = normalizeSource(input.source);
    } catch (error) {
      if (error instanceof InputError) throw new SessionError(400, error.message);
      throw error;
    }
  } else {
    throw new SessionError(400, "Выберите задачу или вставьте код");
  }

  let steps: TraceStep[];
  try {
    steps = await traceJava(source, AbortSignal.timeout(60_000));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось построить трассу";
    throw new SessionError(502, message);
  }

  const session: Session = {
    id: crypto.randomUUID(),
    source,
    steps,
    targets: clickableTargets(source),
    cursor: 0,
    marks: [],
    taskTitle,
  };
  sessions.set(session.id, session);
  return toPublic(session);
}

export function getPublicSession(id: string): PublicSession {
  return toPublic(requireSession(id));
}

export function restartSession(id: string): PublicSession {
  const session = requireSession(id);
  session.cursor = 0;
  session.marks = [];
  session.mistake = undefined;
  return toPublic(session);
}

export function clickSession(
  id: string,
  pick: { line: number; start: number; end: number },
): ClickSuccess | ClickFailure {
  if (!Number.isInteger(pick.line) || pick.line < 1 || !Number.isInteger(pick.start) || !Number.isInteger(pick.end)) {
    throw new SessionError(400, "Нужна строка и границы выражения");
  }
  const session = requireSession(id);
  if (session.cursor >= session.steps.length) {
    throw new SessionError(409, "Трасса уже пройдена");
  }

  const correct = session.steps[session.cursor];
  if (sameSpan(correct, pick)) {
    session.cursor += 1;
    session.marks.push({ line: pick.line, start: pick.start, end: pick.end, step: session.cursor });
    session.mistake = undefined;
    return {
      ok: true,
      cursor: session.cursor,
      totalSteps: session.steps.length,
      done: session.cursor >= session.steps.length,
      marks: session.marks.map((mark) => ({ ...mark })),
    };
  }

  const token = crypto.randomUUID();
  const clickedText = textAt(session, pick) || "этот фрагмент";
  session.mistake = {
    token,
    clickedLine: pick.line,
    clickedText,
    correctLine: correct.line,
    correctText: correct.text,
  };
  return {
    ok: false,
    cursor: session.cursor,
    totalSteps: session.steps.length,
    clickedLine: pick.line,
    clickedStart: pick.start,
    clickedEnd: pick.end,
    correctLine: correct.line,
    correctStart: correct.start,
    correctEnd: correct.end,
    correctText: correct.text,
    fallback: fallbackText(pick.line, clickedText, correct),
    token,
  };
}

export function explainContext(id: string, token: string) {
  const session = requireSession(id);
  if (!session.mistake || session.mistake.token !== token) {
    throw new SessionError(409, "Эта ошибка уже не актуальна");
  }
  return {
    source: session.source,
    steps: session.steps,
    cursor: session.cursor,
    clickedLine: session.mistake.clickedLine,
    clickedText: session.mistake.clickedText,
  };
}

function sameSpan(step: TraceStep, pick: { line: number; start: number; end: number }): boolean {
  return step.line === pick.line && step.start === pick.start && step.end === pick.end;
}

function textAt(session: Session, pick: { line: number; start: number; end: number }): string {
  const known = session.targets.find((target) => sameSpan(target, pick));
  if (known) return known.text;
  const line = session.source.split("\n")[pick.line - 1] ?? "";
  return line.slice(pick.start, pick.end).trim();
}

function fallbackText(clickedLine: number, clickedText: string, correct: TraceStep): string {
  const clicked = `«${clickedText}» на строке ${clickedLine}`;
  const next = `«${correct.text}» на строке ${correct.line}`;
  return `${clicked} сейчас не следующий шаг. Выполняется ${next}.`;
}

function requireSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new SessionError(404, "Сессия не найдена. Начните задачу заново.");
  return session;
}

function toPublic(session: Session): PublicSession {
  return {
    id: session.id,
    source: session.source,
    totalSteps: session.steps.length,
    cursor: session.cursor,
    done: session.cursor >= session.steps.length,
    marks: session.marks.map((mark) => ({ ...mark })),
    targets: session.targets.map((target) => ({ ...target })),
    taskTitle: session.taskTitle,
  };
}
