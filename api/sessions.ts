import { createSession } from "./_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { name, hostId } = (await request.json()) as {
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
};
