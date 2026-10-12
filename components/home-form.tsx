"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { highlightLine } from "@/components/highlight";

type TaskCard = {
  id: string;
  title: string;
  blurb: string;
  source: string;
};

export function HomeForm({ tasks }: { tasks: TaskCard[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(tasks[0]?.id ?? "custom");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const task = tasks.find((item) => item.id === selected);
  const custom = selected === "custom";
  const lineCount = useMemo(() => (source.trim() ? source.replace(/\r\n/g, "\n").trim().split("\n").length : 0), [source]);

  async function start() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(custom ? { source } : { taskId: selected }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        setError(data.error ?? "Не удалось начать");
        return;
      }
      router.push(`/play/${data.id}`);
    } catch {
      setError("Сервер не ответил");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="shell">
      <p className="eyebrow">Упражнение</p>
      <h1>Какая строка выполнится следующей?</h1>
      <p className="lede">
        Кликайте Java в порядке исполнения. Если шаг неверный, верная строка появляется сразу, а следом — короткое объяснение, почему выбрана не она.
      </p>

      <div className="pick">
        {tasks.map((item) => (
          <button
            key={item.id}
            type="button"
            className={selected === item.id ? "choice is-selected" : "choice"}
            onClick={() => setSelected(item.id)}
            disabled={pending}
          >
            <strong>{item.title}</strong>
            <span>{item.blurb}</span>
          </button>
        ))}
        <button
          type="button"
          className={custom ? "choice is-selected" : "choice"}
          onClick={() => setSelected("custom")}
          disabled={pending}
        >
          <strong>Свой код</strong>
          <span>Один файл с методом main</span>
        </button>
      </div>

      {custom ? (
        <textarea
          className="editor"
          value={source}
          spellCheck={false}
          placeholder={"public class Main {\n    public static void main(String[] args) {\n        \n    }\n}"}
          onChange={(event) => setSource(event.target.value)}
          disabled={pending}
        />
      ) : (
        <pre className="preview">
          {task
            ? task.source.split("\n").map((line, index) => (
                <span key={index}>
                  {highlightLine(line)}
                  {"\n"}
                </span>
              ))
            : null}
        </pre>
      )}

      <div className="actions">
        <button type="button" className="primary" onClick={start} disabled={pending || (custom && !source.trim())}>
          {pending ? "Строим трассу…" : "Начать"}
        </button>
        {custom ? <span className="meta">{lineCount} из 100 строк</span> : null}
        {error ? <span className="error-text">{error}</span> : null}
      </div>
    </main>
  );
}
