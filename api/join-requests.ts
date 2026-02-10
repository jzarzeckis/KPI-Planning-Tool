import { getJoinRequests } from "./_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
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
};
