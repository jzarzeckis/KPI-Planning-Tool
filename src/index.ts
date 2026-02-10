import { serve } from "bun";
import index from "./index.html";
import {
  createSession,
  deleteSession,
  submitJoinRequest,
  getJoinRequests,
  submitAnswer,
  getAnswer,
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
          case "create-session": {
            const { name, hostId } = body as { name: string; hostId: string };
            if (!name || !hostId)
              return Response.json(
                { ok: false, error: "name and hostId required" },
                { status: 400 },
              );
            const result = createSession(name, hostId);
            return Response.json(result, { status: result.ok ? 201 : 409 });
          }
          case "join": {
            const { session, peerId, offer } = body as {
              session: string;
              peerId: string;
              offer: string;
            };
            if (!session || !peerId || !offer)
              return Response.json(
                { ok: false, error: "session, peerId, and offer required" },
                { status: 400 },
              );
            const result = submitJoinRequest(session, peerId, offer);
            return Response.json(result, { status: result.ok ? 200 : 404 });
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
          case "join-requests": {
            const session = url.searchParams.get("session");
            const hostId = url.searchParams.get("hostId");
            if (!session || !hostId)
              return Response.json(
                { ok: false, error: "session and hostId required" },
                { status: 400 },
              );
            const result = getJoinRequests(session, hostId);
            return Response.json(result, { status: result.ok ? 200 : 404 });
          }
          case "get-answer": {
            const session = url.searchParams.get("session");
            const peerId = url.searchParams.get("peerId");
            if (!session || !peerId)
              return Response.json(
                { ok: false, error: "session and peerId required" },
                { status: 400 },
              );
            const result = getAnswer(session, peerId);
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
