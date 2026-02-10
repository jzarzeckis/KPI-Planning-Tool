/**
 * Shared in-memory signaling store for Vercel serverless functions.
 *
 * Host pre-creates an offer and posts it. Joiners read the offer instantly,
 * create an answer, and post it back. Only the host polls for answers.
 */

interface Session {
  name: string;
  hostId: string;
  createdAt: number;
  lastHostPoll: number;
  currentOffer: string | null;
  pendingAnswer: { peerId: string; answer: string } | null;
}

const sessions = new Map<string, Session>();

const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const HOST_POLL_TIMEOUT_MS = 2 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [name, session] of sessions) {
    if (
      now - session.createdAt > SESSION_MAX_AGE_MS ||
      now - session.lastHostPoll > HOST_POLL_TIMEOUT_MS
    ) {
      sessions.delete(name);
    }
  }
}

export function joinSession(
  name: string,
):
  | { ok: true; role: "host" }
  | { ok: true; role: "joiner"; offer: string }
  | { ok: false; error: string } {
  cleanup();
  const existing = sessions.get(name);
  if (!existing) {
    return { ok: true, role: "host" };
  }
  if (Date.now() - existing.lastHostPoll > 10_000) {
    sessions.delete(name);
    return { ok: true, role: "host" };
  }
  if (existing.currentOffer) {
    const offer = existing.currentOffer;
    existing.currentOffer = null;
    return { ok: true, role: "joiner", offer };
  }
  return { ok: false, error: "Session busy, try again" };
}

export function createSession(
  name: string,
  hostId: string,
  offer: string,
): { ok: true } | { ok: false; error: string } {
  const existing = sessions.get(name);
  if (existing) {
    const stale = Date.now() - existing.lastHostPoll > 10_000;
    if (!stale) {
      return { ok: false, error: "Session name already taken" };
    }
  }
  sessions.set(name, {
    name,
    hostId,
    createdAt: Date.now(),
    lastHostPoll: Date.now(),
    currentOffer: offer,
    pendingAnswer: null,
  });
  return { ok: true };
}

export function submitAnswer(
  name: string,
  peerId: string,
  answer: string,
): { ok: true } | { ok: false; error: string } {
  const session = sessions.get(name);
  if (!session) return { ok: false, error: "Session not found" };
  session.pendingAnswer = { peerId, answer };
  return { ok: true };
}

export function pollAnswer(
  name: string,
  hostId: string,
):
  | { ok: true; peerId: string; answer: string }
  | { ok: true; peerId: null }
  | { ok: false; error: string } {
  const session = sessions.get(name);
  if (!session) return { ok: false, error: "Session not found" };
  if (session.hostId !== hostId) return { ok: false, error: "Not the host" };

  session.lastHostPoll = Date.now();

  if (session.pendingAnswer) {
    const { peerId, answer } = session.pendingAnswer;
    session.pendingAnswer = null;
    return { ok: true, peerId, answer };
  }
  return { ok: true, peerId: null };
}

export function replaceOffer(
  name: string,
  hostId: string,
  offer: string,
): { ok: true } | { ok: false; error: string } {
  const session = sessions.get(name);
  if (!session) return { ok: false, error: "Session not found" };
  if (session.hostId !== hostId) return { ok: false, error: "Not the host" };

  session.currentOffer = offer;
  return { ok: true };
}

export function deleteSession(name: string, hostId: string): boolean {
  const session = sessions.get(name);
  if (!session || session.hostId !== hostId) return false;
  sessions.delete(name);
  return true;
}
