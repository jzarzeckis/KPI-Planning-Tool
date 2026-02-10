import { deleteSession } from "../../_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "DELETE") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const name = url.pathname.split("/")[3]; // /api/sessions/{name}

    const hostId = url.searchParams.get("hostId");
    if (!hostId) {
      return Response.json(
        { ok: false, error: "hostId required" },
        { status: 400 },
      );
    }
    const ok = deleteSession(name, hostId);
    return Response.json({ ok }, { status: ok ? 200 : 404 });
  },
};
