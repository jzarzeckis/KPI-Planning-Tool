import { getAnswer } from "./_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
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
};
