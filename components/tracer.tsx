"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ClickFailure, ClickSuccess, PublicSession, Span, StepMark } from "@/lib/types";
import { highlightLine } from "@/components/highlight";

type Mistake = {
  clickedLine: number;
  clickedStart: number;
  clickedEnd: number;
  correctLine: number;
  correctStart: number;
  correctEnd: number;
  correctText: string;
  fallback: string;
  token: string;
};

export function Tracer({ id }: { id: string }) {
  const [session, setSession] = useState<PublicSession | null>(null);
  const [mistake, setMistake] = useState<Mistake | null>(null);
  const [why, setWhy] = useState("");
  const [whyStatus, setWhyStatus] = useState<"loading" | "ready" | "fallback">("ready");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const explainAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const response = await fetch(`/api/sessions/${id}`);
      const data = (await response.json()) as PublicSession & { error?: string };
      if (cancel) return;
      if (!response.ok) setError(data.error ?? "Сессия не найдена");
      else setSession(data);
      setLoading(false);
    })().catch(() => {
      if (!cancel) {
        setError("Сервер не ответил");
        setLoading(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [id]);

  useEffect(() => {
    if (!mistake) return;
    document
      .querySelector(`[data-line="${mistake.correctLine}"][data-start="${mistake.correctStart}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [mistake]);

  useEffect(() => {
    return () => explainAbort.current?.abort();
  }, []);

  function stopExplain() {
    explainAbort.current?.abort();
    explainAbort.current = null;
  }

  async function streamExplain(token: string, fallback: string) {
    stopExplain();
    const controller = new AbortController();
    explainAbort.current = controller;
    setWhy("");
    setWhyStatus("loading");
    let received = "";
    try {
      const response = await fetch(`/api/sessions/${id}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok || !response.body) throw new Error("explain failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (explainAbort.current !== controller) return;
        setWhy(received);
        setWhyStatus("ready");
      }
      if (!received.trim()) {
        setWhy(fallback);
        setWhyStatus("fallback");
      }
    } catch {
      if (controller.signal.aborted || received.trim()) return;
      setWhy(fallback);
      setWhyStatus("fallback");
    }
  }

  async function onPick(target: Span) {
    if (!session || session.done || busy) return;
    setBusy(true);
    stopExplain();
    setError("");
    try {
      const response = await fetch(`/api/sessions/${id}/click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: target.line, start: target.start, end: target.end }),
      });
      const data = (await response.json()) as (ClickSuccess | ClickFailure) & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Не удалось проверить шаг");
        return;
      }
      if (data.ok) {
        setSession((current) =>
          current
            ? { ...current, cursor: data.cursor, done: data.done, marks: data.marks, totalSteps: data.totalSteps }
            : current,
        );
        setMistake(null);
        setWhy("");
        return;
      }
      const nextMistake = {
        clickedLine: data.clickedLine,
        clickedStart: data.clickedStart,
        clickedEnd: data.clickedEnd,
        correctLine: data.correctLine,
        correctStart: data.correctStart,
        correctEnd: data.correctEnd,
        correctText: data.correctText,
        fallback: data.fallback,
        token: data.token,
      };
      setMistake(nextMistake);
      void streamExplain(nextMistake.token, nextMistake.fallback);
    } catch {
      setError("Сервер не ответил");
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    stopExplain();
    setMistake(null);
    setWhy("");
    try {
      const response = await fetch(`/api/sessions/${id}/restart`, { method: "POST" });
      const data = (await response.json()) as PublicSession & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Не удалось начать сначала");
        return;
      }
      setSession(data);
    } catch {
      setError("Сервер не ответил");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="shell status">Открываем задачу…</p>;
  if (!session) {
    return (
      <main className="shell">
        <p className="error-text">{error || "Сессия не найдена"}</p>
        <p>
          <Link href="/">К списку задач</Link>
        </p>
      </main>
    );
  }

  const lines = session.source.split("\n");
  const progress = session.totalSteps === 0 ? 0 : Math.round((session.cursor / session.totalSteps) * 100);

  return (
    <main className="shell">
      <div className="play-top">
        <div>
          <p className="eyebrow">{session.taskTitle}</p>
          <h1>Что выполнится следующим?</h1>
        </div>
        <div>
          <p className="step-label">{session.done ? "Трасса пройдена" : `Шаг ${session.cursor + 1} из ${session.totalSteps}`}</p>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <div className="stage">
        <div className="code-scroll">
          {lines.map((text, index) => (
            <CodeLine
              key={index + 1}
              line={index + 1}
              text={text}
              targets={session.targets.filter((target) => target.line === index + 1)}
              marks={session.marks}
              mistake={mistake}
              disabled={busy || session.done}
              onPick={onPick}
            />
          ))}
        </div>

        <aside className={mistake ? "feedback is-open" : session.done ? "feedback is-done" : "feedback"}>
          {mistake ? (
            <>
              <h2>Неверный шаг</h2>
              <div className="correct-line">
                <small>Следующий шаг — строка {mistake.correctLine}</small>
                {mistake.correctText || " "}
              </div>
              <p className="why">
                {whyStatus === "loading" && !why ? "Собираем объяснение…" : why}
              </p>
            </>
          ) : session.done ? (
            <>
              <h2>Порядок верный</h2>
              <p>Все {session.totalSteps} шагов отмечены. Можно пройти ту же трассу ещё раз.</p>
            </>
          ) : (
            <>
              <h2>Клик по шагу</h2>
              <p>
                {session.creative
                  ? "Отметьте следующий фрагмент. Для известного языка кнопки нарезает tree-sitter, а порядок выбирает модель."
                  : "Отметьте следующий фрагмент. После вызова своего метода выполняется его тело, и только потом следующий аргумент. Внешний вызов идёт последним. В заголовке for сначала инициализация, затем условие; после тела — шаг цикла и снова условие."}
              </p>
            </>
          )}
          {error ? <p className="error-text">{error}</p> : null}
        </aside>
      </div>

      <div className="play-actions">
        <button type="button" className="ghost" onClick={restart} disabled={busy}>
          Сначала
        </button>
        <Link href="/">К списку задач</Link>
      </div>
    </main>
  );
}

function CodeLine({
  line,
  text,
  targets,
  marks,
  mistake,
  disabled,
  onPick,
}: {
  line: number;
  text: string;
  targets: Span[];
  marks: StepMark[];
  mistake: Mistake | null;
  disabled: boolean;
  onPick: (target: Span) => void;
}) {
  const ordered = targets.slice().sort((left, right) => left.start - right.start);
  const parts: { kind: "text" | "target"; text: string; target?: Span }[] = [];
  let cursor = 0;
  for (const target of ordered) {
    if (target.start > cursor) parts.push({ kind: "text", text: text.slice(cursor, target.start) });
    parts.push({ kind: "target", text: text.slice(target.start, target.end), target });
    cursor = target.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  if (parts.length === 0) parts.push({ kind: "text", text: "\u00a0" });

  return (
    <div className="line" data-line={line}>
      <span className="ln">{line}</span>
      <span className="src">
        {parts.map((part, index) => {
          if (part.kind === "text" || !part.target) {
            return <span key={index}>{part.text ? highlightLine(part.text) : "\u00a0"}</span>;
          }
          const target = part.target;
          const spanMarks = marks.filter((mark) => sameTarget(mark, target));
          const isWrong = Boolean(
            mistake &&
              mistake.clickedLine === target.line &&
              mistake.clickedStart === target.start &&
              mistake.clickedEnd === target.end &&
              !sameCorrect(mistake, target),
          );
          const isExpected = mistake ? sameCorrect(mistake, target) : false;
          const fragment = target.text.length < text.trim().length;
          const callName = /^[$A-Za-z_][\w$]*$/.test(target.text);
          const className = [fragment ? "expr" : "hit", isWrong ? "is-wrong" : "", isExpected ? "is-expected" : ""].filter(Boolean).join(" ");
          return (
            <button
              key={index}
              type="button"
              className={className}
              data-line={line}
              data-start={target.start}
              disabled={disabled}
              aria-label={callName && fragment ? `Вызов ${target.text}, строка ${line}` : `${target.text}, строка ${line}`}
              onClick={() => onPick(target)}
            >
              {highlightLine(part.text)}
              {spanMarks.map((mark) => (
                <i key={mark.step}>{mark.step}</i>
              ))}
            </button>
          );
        })}
      </span>
    </div>
  );
}

function sameTarget(mark: { line: number; start: number; end: number }, target: Span): boolean {
  return mark.line === target.line && mark.start === target.start && mark.end === target.end;
}

function sameCorrect(mistake: Mistake, target: Span): boolean {
  return mistake.correctLine === target.line && mistake.correctStart === target.start && mistake.correctEnd === target.end;
}
