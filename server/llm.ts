import { completeText, type ChatMessage } from "@/server/litellm";
import { numberSource } from "@/server/source";
import type { TraceStep } from "@/server/trace";

function systemPrompt(language?: string): string {
  const subject = language ? `кода на языке ${language}` : "Java";
  return `Ты объясняешь ошибку в упражнении на порядок исполнения ${subject}.
Ответь по-русски, 2–4 предложения.
Скажи, почему выбранный фрагмент не выполняется следующим, и какой вызов или оператор следующий и что он делает.
Не перечисляй шаги после верной строки.
Не используй заголовки и списки.`;
}

export function buildExplainMessages(input: {
  source: string;
  steps: TraceStep[];
  cursor: number;
  clickedLine: number;
  clickedText: string;
  language?: string;
}): ChatMessage[] {
  const correct = input.steps[input.cursor];
  if (!correct) {
    throw new Error("Нет следующего шага");
  }
  const recent = input.steps.slice(Math.max(0, input.cursor - 5), input.cursor);
  const history =
    recent.length === 0
      ? "Пока не выполнено ни одной строки."
      : recent
          .map((step, index) => {
            const stepNumber = input.cursor - recent.length + index + 1;
            return `${stepNumber}. строка ${step.line}: ${step.text}`;
          })
          .join("\n");

  return [
    { role: "system", content: systemPrompt(input.language) },
    {
      role: "user",
      content: [
        "Исходник:",
        numberSource(input.source),
        "",
        "Уже верно выполненные шаги:",
        history,
        "",
        `Пользователь выбрал «${input.clickedText}» на строке ${input.clickedLine}.`,
        `Следующий шаг — «${correct.text}» на строке ${correct.line}.`,
      ].join("\n"),
    },
  ];
}

export async function openExplainStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const model = process.env.EXPLAIN_MODEL || "openrouter/openrouter/free";
  const text = await completeText({
    model,
    messages,
    temperature: 0.2,
    maxTokens: 400,
    reasoningEffort: "none",
    signal,
  });
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
