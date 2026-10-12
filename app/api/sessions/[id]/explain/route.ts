import { buildExplainMessages, openExplainStream } from "@/server/llm";
import { explainContext, SessionError } from "@/server/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return Response.json({ error: "Нет отметки ошибки" }, { status: 400 });
  }

  try {
    const contextForModel = explainContext(id, body.token);
    const messages = buildExplainMessages(contextForModel);
    const stream = await openExplainStream(messages, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]));
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof SessionError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Не удалось получить объяснение";
    return Response.json({ error: message }, { status: 502 });
  }
}
