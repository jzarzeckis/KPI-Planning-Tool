import { submitAnswer, getAnswer } from "../../../_signaling";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/");
    const name = segments[3]; // /api/sessions/{name}/answer/{peerId}
    const peerId = segments[5];

    if (request.method === "POST") {
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

    if (request.method === "GET") {
      const result = getAnswer(name, peerId);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
