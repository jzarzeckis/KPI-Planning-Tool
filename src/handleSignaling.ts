/**
 * Shared request dispatch for signaling API.
 * Used by both the local Bun dev server and the Vercel serverless function.
 */

import {
  joinSession,
  createSession,
  deleteSession,
  submitAnswer,
  pollAnswer,
  replaceOffer,
} from "./signaling";

export async function handleSignaling(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const method = request.method;

  if (method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON" },
        { status: 400 },
      );
    }

    switch (action) {
      case "join-session": {
        const name = body.name as string | undefined;
        if (!name)
          return Response.json(
            { ok: false, error: "name required" },
            { status: 400 },
          );
        const result = joinSession(name);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }

      case "create-session": {
        const { name, hostId, offer } = body as {
          name?: string;
          hostId?: string;
          offer?: string;
        };
        if (!name || !hostId || !offer)
          return Response.json(
            { ok: false, error: "name, hostId, and offer required" },
            { status: 400 },
          );
        const result = createSession(name, hostId, offer);
        return Response.json(result, { status: result.ok ? 201 : 409 });
      }

      case "submit-answer": {
        const { session, peerId, answer } = body as {
          session?: string;
          peerId?: string;
          answer?: string;
        };
        if (!session || !peerId || !answer)
          return Response.json(
            { ok: false, error: "session, peerId, and answer required" },
            { status: 400 },
          );
        const result = submitAnswer(session, peerId, answer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      }

      case "replace-offer": {
        const { session, hostId, offer } = body as {
          session?: string;
          hostId?: string;
          offer?: string;
        };
        if (!session || !hostId || !offer)
          return Response.json(
            { ok: false, error: "session, hostId, and offer required" },
            { status: 400 },
          );
        const result = replaceOffer(session, hostId, offer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      }

      case "delete-session": {
        const { name, hostId } = body as { name?: string; hostId?: string };
        if (!name || !hostId)
          return Response.json(
            { ok: false, error: "name and hostId required" },
            { status: 400 },
          );
        const result = deleteSession(name, hostId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      }
    }
  }

  if (method === "GET") {
    switch (action) {
      case "poll-answer": {
        const session = url.searchParams.get("session");
        const hostId = url.searchParams.get("hostId");
        if (!session || !hostId)
          return Response.json(
            { ok: false, error: "session and hostId required" },
            { status: 400 },
          );
        const result = pollAnswer(session, hostId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      }
    }
  }

  return Response.json(
    { ok: false, error: "Unknown action" },
    { status: 400 },
  );
}
