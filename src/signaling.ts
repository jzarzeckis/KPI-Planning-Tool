/**
 * Server-side in-memory signaling store for WebRTC session management.
 *
 * New protocol: host pre-creates an offer and posts it. Joiners read the offer
 * instantly (no polling), create an answer, and post it back. Only the host
 * polls for answers.
 */

interface Session {
  name: string;
  hostId: string;
  createdAt: number;
  lastHostPoll: number;
  /** Host's pre-created offer, null when consumed by a joiner */
  currentOffer: string | null;
  /** Joiner's answer waiting for the host to pick up */
  pendingAnswer: { peerId: string; answer: string } | null;
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

/** Try to join a session. If it doesn't exist, caller becomes host. */
export function joinSession(
  name: string,
):
  | { ok: true; role: "host" }
  | { ok: true; role: "joiner"; offer: string }
  | { ok: false; error: string } {
  const existing = sessions.get(name);
  if (!existing) {
    return { ok: true, role: "host" };
  }
  // Session exists but host stopped polling (stale) — take over
  if (Date.now() - existing.lastHostPoll > 10_000) {
    sessions.delete(name);
    return { ok: true, role: "host" };
  }
  // Session exists, has an offer ready
  if (existing.currentOffer) {
    const offer = existing.currentOffer;
    existing.currentOffer = null; // consume it
    return { ok: true, role: "joiner", offer };
  }
  // Session exists but no offer ready (host is generating next one)
  return { ok: false, error: "Session busy, try again" };
}

/** Host creates the session with their first offer. */
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

/** Joiner submits their answer after receiving the host's offer. */
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

/** Host polls for a joiner's answer. */
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

/** Host posts a new offer for the next joiner. */
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

/** Delete a session. */
export function deleteSession(name: string, hostId: string): boolean {
  const session = sessions.get(name);
  if (!session || session.hostId !== hostId) return false;
  sessions.delete(name);
  return true;
}
