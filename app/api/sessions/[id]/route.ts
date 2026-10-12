import { getPublicSession, SessionError } from "@/server/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    return Response.json(getPublicSession(id));
  } catch (error) {
    if (error instanceof SessionError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Сессия не найдена" }, { status: 404 });
  }
}
