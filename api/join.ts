import { submitJoinRequest } from "./_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { session, peerId, offer } = (await request.json()) as {
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
};
