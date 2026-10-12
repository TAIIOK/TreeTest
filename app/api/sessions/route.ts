import { createSession, SessionError } from "@/server/sessions";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { taskId?: unknown; source?: unknown; creative?: unknown };
  try {
    body = (await request.json()) as { taskId?: unknown; source?: unknown; creative?: unknown };
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  try {
    const session = await createSession({
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      creative: body.creative === true,
    });
    return Response.json(session);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof SessionError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Не удалось создать сессию";
  return Response.json({ error: message }, { status: 500 });
}
