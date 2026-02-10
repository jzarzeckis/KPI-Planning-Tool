import {
  deleteSession,
  submitJoinRequest,
  getJoinRequests,
  submitAnswer,
  getAnswer,
} from "../_signaling";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;

    const pathAfterSessions = url.pathname.replace(/^\/api\/sessions\/?/, "");
    const segments = pathAfterSessions ? pathAfterSessions.split("/") : [];

    // DELETE /api/sessions/:name
    if (segments.length === 1 && method === "DELETE") {
      const name = decodeURIComponent(segments[0]);
      const hostId = url.searchParams.get("hostId");
      if (!hostId) {
        return Response.json(
          { ok: false, error: "hostId required" },
          { status: 400 },
        );
      }
      const ok = deleteSession(name, hostId);
      return Response.json({ ok }, { status: ok ? 200 : 404 });
    }

    // POST /api/sessions/:name/join
    if (segments.length === 2 && segments[1] === "join" && method === "POST") {
      const name = decodeURIComponent(segments[0]);
      const { peerId, offer } = (await request.json()) as {
        peerId: string;
        offer: string;
      };
      if (!peerId || !offer) {
        return Response.json(
          { ok: false, error: "peerId and offer required" },
          { status: 400 },
        );
      }
      const result = submitJoinRequest(name, peerId, offer);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    // GET /api/sessions/:name/join-requests
    if (
      segments.length === 2 &&
      segments[1] === "join-requests" &&
      method === "GET"
    ) {
      const name = decodeURIComponent(segments[0]);
      const hostId = url.searchParams.get("hostId");
      if (!hostId) {
        return Response.json(
          { ok: false, error: "hostId required" },
          { status: 400 },
        );
      }
      const result = getJoinRequests(name, hostId);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    // POST /api/sessions/:name/answer/:peerId
    if (
      segments.length === 3 &&
      segments[1] === "answer" &&
      method === "POST"
    ) {
      const name = decodeURIComponent(segments[0]);
      const peerId = decodeURIComponent(segments[2]);
      const { answer } = (await request.json()) as { answer: string };
      if (!answer) {
        return Response.json(
          { ok: false, error: "answer required" },
          { status: 400 },
        );
      }
      const result = submitAnswer(name, peerId, answer);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    // GET /api/sessions/:name/answer/:peerId
    if (segments.length === 3 && segments[1] === "answer" && method === "GET") {
      const name = decodeURIComponent(segments[0]);
      const peerId = decodeURIComponent(segments[2]);
      const result = getAnswer(name, peerId);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  },
};
