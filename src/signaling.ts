/**
 * Server-side in-memory signaling store for WebRTC session management.
 *
 * Sessions live in memory only — no database. A cleanup interval prunes
 * stale sessions (host stopped polling or session is too old).
 */

interface JoinRequest {
  peerId: string;
  offer: string;
  createdAt: number;
  /** Set to true once the host has seen this request */
  consumed: boolean;
}

interface Session {
  name: string;
  hostId: string;
  createdAt: number;
  lastHostPoll: number;
  joinRequests: Map<string, JoinRequest>;
  answers: Map<string, string>; // peerId → answer blob
}

const sessions = new Map<string, Session>();

// -- Cleanup ----------------------------------------------------------------

const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const HOST_POLL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes without polling → stale

setInterval(() => {
  const now = Date.now();
  for (const [name, session] of sessions) {
    if (
      now - session.createdAt > SESSION_MAX_AGE_MS ||
      now - session.lastHostPoll > HOST_POLL_TIMEOUT_MS
    ) {
      sessions.delete(name);
    }
  }
}, 60_000);

// -- Public API -------------------------------------------------------------

export function createSession(
  name: string,
  hostId: string,
): { ok: true } | { ok: false; error: string } {
  const existing = sessions.get(name);
  if (existing) {
    // Allow replacing a stale session (host stopped polling for >10s)
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

/** Host polls for new (unconsumed) join requests. Marks them as consumed. */
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

  // Clean up after delivery
  session.answers.delete(peerId);
  session.joinRequests.delete(peerId);

  return { ok: true, answer };
}
