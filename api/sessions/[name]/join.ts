import { submitJoinRequest } from "../../_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const name = url.pathname.split("/")[3]; // /api/sessions/{name}/join

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
  },
};
