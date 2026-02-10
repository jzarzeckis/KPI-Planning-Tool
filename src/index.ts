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
    "/api/create-session": {
      async POST(req) {
        const { name, hostId } = (await req.json()) as {
          name: string;
          hostId: string;
        };
        if (!name || !hostId) {
          return Response.json(
            { ok: false, error: "name and hostId required" },
            { status: 400 },
          );
        }
        const result = createSession(name, hostId);
        return Response.json(result, { status: result.ok ? 201 : 409 });
      },
    },

    "/api/join": {
      async POST(req) {
        const { session, peerId, offer } = (await req.json()) as {
          session: string;
          peerId: string;
          offer: string;
        };
        if (!session || !peerId || !offer) {
          return Response.json(
            { ok: false, error: "session, peerId, and offer required" },
            { status: 400 },
          );
        }
        const result = submitJoinRequest(session, peerId, offer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/join-requests": {
      GET(req) {
        const url = new URL(req.url);
        const session = url.searchParams.get("session");
        const hostId = url.searchParams.get("hostId");
        if (!session || !hostId) {
          return Response.json(
            { ok: false, error: "session and hostId required" },
            { status: 400 },
          );
        }
        const result = getJoinRequests(session, hostId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/submit-answer": {
      async POST(req) {
        const { session, peerId, answer } = (await req.json()) as {
          session: string;
          peerId: string;
          answer: string;
        };
        if (!session || !peerId || !answer) {
          return Response.json(
            { ok: false, error: "session, peerId, and answer required" },
            { status: 400 },
          );
        }
        const result = submitAnswer(session, peerId, answer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/get-answer": {
      GET(req) {
        const url = new URL(req.url);
        const session = url.searchParams.get("session");
        const peerId = url.searchParams.get("peerId");
        if (!session || !peerId) {
          return Response.json(
            { ok: false, error: "session and peerId required" },
            { status: 400 },
          );
        }
        const result = getAnswer(session, peerId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/delete-session": {
      async POST(req) {
        const { name, hostId } = (await req.json()) as {
          name: string;
          hostId: string;
        };
        if (!name || !hostId) {
          return Response.json(
            { ok: false, error: "name and hostId required" },
            { status: 400 },
          );
        }
        const ok = deleteSession(name, hostId);
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      },
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
