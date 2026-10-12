export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function config() {
  const baseUrl = process.env.LITELLM_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.LITELLM_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("Не заданы LITELLM_BASE_URL и LITELLM_API_KEY");
  }
  return { baseUrl, apiKey };
}

export async function chooseNext(options: {
  model: string;
  state: string;
  instructions: string;
  criteria: Record<string, string>;
  signal?: AbortSignal;
}): Promise<string> {
  const { baseUrl, apiKey } = config();
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      state: options.state,
      questions: {
        next: {
          type: "choice",
          instructions: options.instructions,
          criteria: options.criteria,
        },
      },
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LiteLLM ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    answers?: { next?: { choice?: unknown } };
  };
  const choice = data.answers?.next?.choice;
  if (typeof choice !== "string" || !choice) {
    throw new Error("JEV не выбрал следующий шаг");
  }
  return choice;
}

export async function completeText(options: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "none";
  signal?: AbortSignal;
}): Promise<string> {
  const { baseUrl, apiKey } = config();
  const body: Record<string, unknown> = {
    model: options.model,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens,
    messages: options.messages,
    stream: false,
  };
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
    body.allowed_openai_params = ["reasoning_effort"];
  }
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LiteLLM ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  };
  const message = data.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  const text = content || (isRussianExplanation(reasoning) ? reasoning : "");
  if (!text) {
    throw new Error("Пустой ответ модели");
  }
  return text;
}

function isRussianExplanation(text: string): boolean {
  const cyrillic = text.match(/[А-Яа-яЁё]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cyrillic >= 40 && cyrillic > latin;
}
