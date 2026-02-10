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
    "/api/sessions": {
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

    "/api/sessions/:name/join": {
      async POST(req) {
        const { peerId, offer } = (await req.json()) as {
          peerId: string;
          offer: string;
        };
        if (!peerId || !offer) {
          return Response.json(
            { ok: false, error: "peerId and offer required" },
            { status: 400 },
          );
        }
        const result = submitJoinRequest(req.params.name, peerId, offer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/sessions/:name/join-requests": {
      GET(req) {
        const hostId = new URL(req.url).searchParams.get("hostId");
        if (!hostId) {
          return Response.json(
            { ok: false, error: "hostId required" },
            { status: 400 },
          );
        }
        const result = getJoinRequests(req.params.name, hostId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/sessions/:name/answer/:peerId": {
      async POST(req) {
        const { answer } = (await req.json()) as { answer: string };
        if (!answer) {
          return Response.json(
            { ok: false, error: "answer required" },
            { status: 400 },
          );
        }
        const result = submitAnswer(req.params.name, req.params.peerId, answer);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
      GET(req) {
        const result = getAnswer(req.params.name, req.params.peerId);
        return Response.json(result, { status: result.ok ? 200 : 404 });
      },
    },

    "/api/sessions/:name": {
      DELETE(req) {
        const hostId = new URL(req.url).searchParams.get("hostId");
        if (!hostId) {
          return Response.json(
            { ok: false, error: "hostId required" },
            { status: 400 },
          );
        }
        const ok = deleteSession(req.params.name, hostId);
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
