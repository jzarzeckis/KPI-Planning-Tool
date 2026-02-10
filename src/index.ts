import { serve } from "bun";
import index from "./index.html";
import {
  joinSession,
  createSession,
  deleteSession,
  submitAnswer,
  pollAnswer,
  replaceOffer,
} from "./signaling";

const server = serve({
  routes: {
    "/api/signaling": async (req) => {
      const url = new URL(req.url);
      const action = url.searchParams.get("action");
      const method = req.method;

      if (method === "POST") {
        const body = await req.json();
        switch (action) {
          case "join-session": {
            const { name } = body as { name: string };
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
              name: string;
              hostId: string;
              offer: string;
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
              session: string;
              peerId: string;
              answer: string;
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
              session: string;
              hostId: string;
              offer: string;
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
            const { name, hostId } = body as { name: string; hostId: string };
            if (!name || !hostId)
              return Response.json(
                { ok: false, error: "name and hostId required" },
                { status: 400 },
              );
            const ok = deleteSession(name, hostId);
            return Response.json({ ok }, { status: ok ? 200 : 404 });
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
    },

    // Serve index.html for all unmatched routes (SPA)
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
