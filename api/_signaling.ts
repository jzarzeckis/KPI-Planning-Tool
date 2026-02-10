/**
 * Shared in-memory signaling store for Vercel serverless functions.
 *
 * Sessions live in memory only — works within a single Vercel function
 * instance (Fluid compute keeps instances warm for reuse).
 */

interface JoinRequest {
  peerId: string;
  offer: string;
  createdAt: number;
  consumed: boolean;
}

interface Session {
  name: string;
  hostId: string;
  createdAt: number;
  lastHostPoll: number;
  joinRequests: Map<string, JoinRequest>;
  answers: Map<string, string>;
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

export function createSession(
  name: string,
  hostId: string,
): { ok: true } | { ok: false; error: string } {
  cleanup();
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
    joinRequests: new Map(),
    answers: new Map(),
  });
  return { ok: true };
}

export function deleteSession(name: string, hostId: string): boolean {
  const session = sessions.get(name);
  if (!session || session.hostId !== hostId) return false;
  sessions.delete(name);
  return true;
}

export function submitJoinRequest(
  sessionName: string,
  peerId: string,
  offer: string,
): { ok: true } | { ok: false; error: string } {
  const session = sessions.get(sessionName);
  if (!session) return { ok: false, error: "Session not found" };

  session.joinRequests.set(peerId, {
    peerId,
    offer,
    createdAt: Date.now(),
    consumed: false,
  });
  return { ok: true };
}

export function getJoinRequests(
  sessionName: string,
  hostId: string,
):
  | { ok: true; requests: { peerId: string; offer: string }[] }
  | { ok: false; error: string } {
  const session = sessions.get(sessionName);
  if (!session) return { ok: false, error: "Session not found" };
  if (session.hostId !== hostId) return { ok: false, error: "Not the host" };

  session.lastHostPoll = Date.now();

  const pending: { peerId: string; offer: string }[] = [];
  for (const req of session.joinRequests.values()) {
    if (!req.consumed) {
      pending.push({ peerId: req.peerId, offer: req.offer });
      req.consumed = true;
    }
  }
  return { ok: true, requests: pending };
}

export function submitAnswer(
  sessionName: string,
  peerId: string,
  answer: string,
): { ok: true } | { ok: false; error: string } {
  const session = sessions.get(sessionName);
  if (!session) return { ok: false, error: "Session not found" };

  session.answers.set(peerId, answer);
  return { ok: true };
}

export function getAnswer(
  sessionName: string,
  peerId: string,
): { ok: true; answer: string } | { ok: false; error: string } {
  const session = sessions.get(sessionName);
  if (!session) return { ok: false, error: "Session not found" };

  const answer = session.answers.get(peerId);
  if (!answer) return { ok: false, error: "No answer yet" };

  session.answers.delete(peerId);
  session.joinRequests.delete(peerId);

  return { ok: true, answer };
}
