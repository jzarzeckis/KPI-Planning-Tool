import { submitAnswer } from "./_signaling";

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { session, peerId, answer } = (await request.json()) as {
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
};
