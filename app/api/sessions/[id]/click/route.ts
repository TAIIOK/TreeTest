import { clickSession, SessionError } from "@/server/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  let body: { line?: unknown; start?: unknown; end?: unknown };
  try {
    body = (await request.json()) as { line?: unknown; start?: unknown; end?: unknown };
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  try {
    const result = clickSession(id, {
      line: Number(body.line),
      start: Number(body.start),
      end: Number(body.end),
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof SessionError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Не удалось проверить шаг" }, { status: 500 });
  }
}
