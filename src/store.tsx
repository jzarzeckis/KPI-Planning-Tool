/**
 * React context wiring a Yjs Y.Doc to WebRTC peers via server-assisted signaling.
 *
 * Architecture: Star topology. The host maintains a data channel to each joiner
 * and relays yjs updates between them. Joiners only connect to the host.
 *
 * Persistence: 2s debounced localStorage save on every Y.Doc update.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as Y from "yjs";
import { createOffer, acceptOffer, acceptAnswer } from "./webrtc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeKind = "goal" | "kpi" | "initiative";

export interface LogEntry {
  user: string;
  action: string;
  timestamp: number;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  name: string;
  enabled: boolean;
  weight: number;
  log: LogEntry[];
  childIds: string[];
}

export type SessionState =
  | "idle"
  | "creating"
  | "hosting"
  | "joining"
  | "connected"
  | "error";

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY = "roadmap-kpi-planner-yjs";

function saveToLocalStorage(doc: Y.Doc) {
  const state = Y.encodeStateAsUpdate(doc);
  localStorage.setItem(LS_KEY, btoa(String.fromCharCode(...state)));
}

function loadFromLocalStorage(doc: Y.Doc): boolean {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return false;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    Y.applyUpdate(doc, bytes);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Y.Doc → TreeNode helpers
// ---------------------------------------------------------------------------

function getNodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
}

function readNode(
  nodesMap: Y.Map<Y.Map<unknown>>,
  id: string,
): TreeNode | null {
  const yNode = nodesMap.get(id);
  if (!yNode) return null;
  const childIdsArr = yNode.get("childIds") as Y.Array<string> | undefined;
  const logArr = yNode.get("log") as Y.Array<LogEntry> | undefined;
  return {
    id,
    kind: (yNode.get("kind") as NodeKind) ?? "goal",
    parentId: (yNode.get("parentId") as string | null) ?? null,
    name: (yNode.get("name") as string) ?? "",
    enabled: (yNode.get("enabled") as boolean) ?? true,
    weight: (yNode.get("weight") as number) ?? 0.5,
    log: logArr ? logArr.toArray() : [],
    childIds: childIdsArr ? childIdsArr.toArray() : [],
  };
}

function getRootIds(nodesMap: Y.Map<Y.Map<unknown>>): string[] {
  const roots: string[] = [];
  nodesMap.forEach((_v, id) => {
    const yNode = nodesMap.get(id)!;
    if (yNode.get("parentId") === null) roots.push(id);
  });
  return roots;
}

// ---------------------------------------------------------------------------
// Peer tracking (used by host)
// ---------------------------------------------------------------------------

export type PeerStatus = "connecting" | "connected" | "disconnected";

export interface PeerInfo {
  peerId: string;
  status: PeerStatus;
}

interface PeerEntry {
  peerId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: PeerStatus;
  disconnectedAt?: number;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface StoreCtx {
  doc: Y.Doc;
  userName: string;
  setUserName: (n: string) => void;

  sessionState: SessionState;
  sessionName: string | null;
  peerCount: number;
  peers: PeerInfo[];
  errorMessage: string | null;

  hostSession: (name: string) => Promise<void>;
  joinSession: (name: string) => Promise<void>;
  leaveSession: () => void;

  getNode: (id: string) => TreeNode | null;
  getRootIds: () => string[];

  addNode: (parentId: string | null, kind: NodeKind, name: string) => string;
  renameNode: (id: string, name: string) => void;
  toggleNode: (id: string) => void;
  setWeight: (id: string, weight: number) => void;
}

const Ctx = createContext<StoreCtx>(null!);
export function useStore() {
  return useContext(Ctx);
}

export function useYjsSnapshot() {
  const { doc } = useStore();
  const versionRef = useRef(0);
  return useSyncExternalStore(
    (cb) => {
      const handler = () => {
        versionRef.current++;
        cb();
      };
      doc.on("update", handler);
      return () => doc.off("update", handler);
    },
    () => versionRef.current,
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function StoreProvider({ children }: { children: ReactNode }) {
  const docRef = useRef(new Y.Doc());
  const doc = docRef.current;

  const [userName, setUserName] = useState(
    () => `User-${doc.clientID.toString(36).slice(0, 4)}`,
  );
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Host identity (random per session, used to authenticate polling)
  const hostIdRef = useRef<string | null>(null);
  // All peer connections (host keeps many, joiner keeps one)
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  // Polling interval refs
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track if this instance is the host
  const isHostRef = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    loadFromLocalStorage(doc);
  }, [doc]);

  // -- Debounced localStorage persistence -----------------------------------

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveToLocalStorage(doc), 2000);
    };
    doc.on("update", handler);
    return () => {
      doc.off("update", handler);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [doc]);

  // -- Broadcast to peers (host sends to all, joiner sends to host) ---------

  const broadcastUpdate = useCallback(
    (update: Uint8Array, excludePeerId?: string) => {
      for (const [pid, peer] of peersRef.current) {
        if (pid === excludePeerId) continue;
        if (peer.dc && peer.dc.readyState === "open") {
          peer.dc.send(update);
        }
      }
    },
    [],
  );

  // Send local yjs updates to peers
  useEffect(() => {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      broadcastUpdate(update);
    };
    doc.on("update", handler);
    return () => doc.off("update", handler);
  }, [doc, broadcastUpdate]);

  // -- Peer state tracking --------------------------------------------------

  const updatePeersState = useCallback(() => {
    const list: PeerInfo[] = [];
    let count = 0;
    for (const entry of peersRef.current.values()) {
      list.push({ peerId: entry.peerId, status: entry.status });
      if (entry.status === "connected") count++;
    }
    setPeers(list);
    setPeerCount(count);
  }, []);

  // -- Host: handle incoming yjs update from a specific peer ----------------

  const makeHostOnMessage = useCallback(
    (fromPeerId: string) => (data: Uint8Array) => {
      // Apply to local doc
      Y.applyUpdate(doc, data, "remote");
      // Relay to all OTHER peers
      broadcastUpdate(data, fromPeerId);
    },
    [doc, broadcastUpdate],
  );

  // -- Host: process a single join request ----------------------------------

  const handleJoinRequest = useCallback(
    async (peerId: string, offerString: string, name: string) => {
      // Track peer immediately as "connecting"
      const entry: PeerEntry = {
        peerId,
        pc: null!,
        dc: null,
        status: "connecting",
      };
      peersRef.current.set(peerId, entry);
      updatePeersState();

      const {
        pc,
        dc: dcPromise,
        answerString,
      } = await acceptOffer(
        offerString,
        makeHostOnMessage(peerId),
        () => {
          // onOpen: send full doc state
          const peer = peersRef.current.get(peerId);
          if (peer) {
            peer.status = "connected";
            if (peer.dc && peer.dc.readyState === "open") {
              peer.dc.send(Y.encodeStateAsUpdate(doc));
            }
          }
          updatePeersState();
        },
        () => {
          // onClose: mark as disconnected (don't delete)
          const peer = peersRef.current.get(peerId);
          if (peer) {
            peer.pc.close();
            peer.status = "disconnected";
            peer.disconnectedAt = Date.now();
          }
          updatePeersState();
        },
      );

      entry.pc = pc;

      // Post answer to server
      await fetch(
        `/api/sessions/${encodeURIComponent(name)}/answer/${encodeURIComponent(peerId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: answerString }),
        },
      );

      // dc resolves when data channel opens
      dcPromise.then((dc) => {
        entry.dc = dc;
        updatePeersState();
      });
    },
    [doc, makeHostOnMessage, updatePeersState],
  );

  // -- Host session ---------------------------------------------------------

  const hostSession = useCallback(
    async (name: string) => {
      setSessionState("creating");
      setErrorMessage(null);

      const hostId = crypto.randomUUID();
      hostIdRef.current = hostId;
      isHostRef.current = true;

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, hostId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSessionState("error");
        setErrorMessage(data.error ?? "Failed to create session");
        return;
      }

      setSessionName(name);
      setSessionState("hosting");

      // Poll for join requests every 2s
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(
            `/api/sessions/${encodeURIComponent(name)}/join-requests?hostId=${encodeURIComponent(hostId)}`,
          );
          const d = await r.json();
          if (d.ok && d.requests.length > 0) {
            for (const req of d.requests) {
              handleJoinRequest(req.peerId, req.offer, name);
            }
          }
        } catch {
          // Silently retry on next poll
        }
      }, 2000);
    },
    [handleJoinRequest],
  );

  // -- Join session ---------------------------------------------------------

  // Track whether the joiner is supposed to stay in this session
  // (so reconnect logic knows when to stop)
  const joinedSessionRef = useRef<string | null>(null);

  // Monotonically increasing attempt ID so stale callbacks are no-ops
  const joinAttemptRef = useRef(0);

  /** Clean up any existing joiner connection state before a new attempt. */
  const cleanupJoinerState = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const hostEntry = peersRef.current.get("host");
    if (hostEntry) {
      hostEntry.pc.close();
      peersRef.current.delete("host");
    }
  }, []);

  /** Core connection attempt for a joiner. */
  const attemptJoinConnection = useCallback(
    async (name: string): Promise<void> => {
      const attemptId = ++joinAttemptRef.current;
      const isStale = () =>
        joinAttemptRef.current !== attemptId ||
        joinedSessionRef.current !== name;

      // Clean up previous attempt
      cleanupJoinerState();

      const peerId = crypto.randomUUID();

      let pc: RTCPeerConnection;
      let dc: RTCDataChannel;
      let offerString: string;
      try {
        const result = await createOffer(
          (data) => Y.applyUpdate(doc, data, "remote"),
          () => {
            if (isStale()) return;
            const hostEntry = peersRef.current.get("host");
            if (hostEntry) hostEntry.status = "connected";
            setSessionState("connected");
            updatePeersState();
          },
          () => {
            if (isStale()) return;
            const hostEntry = peersRef.current.get("host");
            if (hostEntry) {
              hostEntry.status = "disconnected";
              hostEntry.disconnectedAt = Date.now();
            }
            updatePeersState();
            setSessionState("joining");
            setTimeout(() => {
              if (!isStale()) attemptJoinConnection(name);
            }, 3000);
          },
        );
        pc = result.pc;
        dc = result.dc;
        offerString = result.offerString;
      } catch {
        if (!isStale()) {
          setTimeout(() => {
            if (!isStale()) attemptJoinConnection(name);
          }, 3000);
        }
        return;
      }

      if (isStale()) {
        pc.close();
        return;
      }

      // Submit offer to server
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(name)}/join`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ peerId, offer: offerString }),
          },
        );
        const data = await res.json();
        if (!data.ok) {
          pc.close();
          if (!isStale()) {
            setTimeout(() => {
              if (!isStale()) attemptJoinConnection(name);
            }, 3000);
          }
          return;
        }
      } catch {
        pc.close();
        if (!isStale()) {
          setTimeout(() => {
            if (!isStale()) attemptJoinConnection(name);
          }, 3000);
        }
        return;
      }

      if (isStale()) {
        pc.close();
        return;
      }

      peersRef.current.set("host", {
        peerId: "host",
        pc,
        dc,
        status: "connecting",
      });
      updatePeersState();

      // Poll for answer every 1s, with a 30s timeout
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        if (isStale() || attempts > 30) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          pc.close();
          peersRef.current.delete("host");
          if (!isStale()) {
            setTimeout(() => {
              if (!isStale()) attemptJoinConnection(name);
            }, 3000);
          }
          return;
        }
        try {
          const r = await fetch(
            `/api/sessions/${encodeURIComponent(name)}/answer/${encodeURIComponent(peerId)}`,
          );
          const d = await r.json();
          if (d.ok && d.answer) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            await acceptAnswer(pc, d.answer);
          }
        } catch {
          // Retry on next poll
        }
      }, 1000);
    },
    [doc, updatePeersState, cleanupJoinerState],
  );

  const joinSession = useCallback(
    async (name: string) => {
      setSessionState("joining");
      setErrorMessage(null);
      isHostRef.current = false;
      joinedSessionRef.current = name;
      setSessionName(name);

      attemptJoinConnection(name);
    },
    [attemptJoinConnection],
  );

  // -- Leave session --------------------------------------------------------

  const leaveSession = useCallback(() => {
    // Stop reconnect loop for joiners
    joinedSessionRef.current = null;

    // Stop polling
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    // Close all peer connections
    for (const peer of peersRef.current.values()) {
      peer.pc.close();
    }
    peersRef.current.clear();

    // Delete session on server if host
    if (isHostRef.current && sessionName && hostIdRef.current) {
      fetch(
        `/api/sessions/${encodeURIComponent(sessionName)}?hostId=${encodeURIComponent(hostIdRef.current)}`,
        { method: "DELETE" },
      ).catch(() => {});
    }

    hostIdRef.current = null;
    isHostRef.current = false;
    setSessionState("idle");
    setSessionName(null);
    setPeerCount(0);
    setPeers([]);
    setErrorMessage(null);
  }, [sessionName]);

  // Auto-cleanup stale disconnected peers
  useEffect(() => {
    const interval = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const [pid, entry] of peersRef.current) {
        if (
          entry.status === "disconnected" &&
          entry.disconnectedAt &&
          now - entry.disconnectedAt > 30_000
        ) {
          peersRef.current.delete(pid);
          changed = true;
        }
      }
      if (changed) updatePeersState();
    }, 10_000);
    return () => clearInterval(interval);
  }, [updatePeersState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      for (const peer of peersRef.current.values()) peer.pc.close();
    };
  }, []);

  // -- Read helpers ---------------------------------------------------------

  const getNode = useCallback(
    (id: string) => readNode(getNodesMap(doc), id),
    [doc],
  );
  const getRootIdsFn = useCallback(() => getRootIds(getNodesMap(doc)), [doc]);

  // -- Mutations ------------------------------------------------------------

  const addNode = useCallback(
    (parentId: string | null, kind: NodeKind, name: string) => {
      const id = crypto.randomUUID();
      const nodesMap = getNodesMap(doc);
      doc.transact(() => {
        const yNode = new Y.Map<unknown>();
        yNode.set("kind", kind);
        yNode.set("parentId", parentId);
        yNode.set("name", name);
        yNode.set("enabled", true);
        yNode.set("weight", 0.5);
        const logArr = new Y.Array<LogEntry>();
        logArr.push([
          {
            user: userName,
            action: `Created ${kind} "${name}"`,
            timestamp: Date.now(),
          },
        ]);
        yNode.set("log", logArr);
        yNode.set("childIds", new Y.Array<string>());
        nodesMap.set(id, yNode);
        if (parentId) {
          const parent = nodesMap.get(parentId);
          if (parent) {
            (parent.get("childIds") as Y.Array<string>).push([id]);
          }
        }
      });
      return id;
    },
    [doc, userName],
  );

  const renameNode = useCallback(
    (id: string, name: string) => {
      const yNode = getNodesMap(doc).get(id);
      if (!yNode) return;
      doc.transact(() => {
        yNode.set("name", name);
        (yNode.get("log") as Y.Array<LogEntry>).push([
          {
            user: userName,
            action: `Renamed to "${name}"`,
            timestamp: Date.now(),
          },
        ]);
      });
    },
    [doc, userName],
  );

  const toggleNode = useCallback(
    (id: string) => {
      const yNode = getNodesMap(doc).get(id);
      if (!yNode) return;
      doc.transact(() => {
        const cur = yNode.get("enabled") as boolean;
        yNode.set("enabled", !cur);
        (yNode.get("log") as Y.Array<LogEntry>).push([
          {
            user: userName,
            action: cur ? "Disabled" : "Enabled",
            timestamp: Date.now(),
          },
        ]);
      });
    },
    [doc, userName],
  );

  const setWeight = useCallback(
    (id: string, weight: number) => {
      const yNode = getNodesMap(doc).get(id);
      if (!yNode) return;
      doc.transact(() => {
        yNode.set("weight", weight);
        (yNode.get("log") as Y.Array<LogEntry>).push([
          {
            user: userName,
            action: `Weight → ${Math.round(weight * 100)}%`,
            timestamp: Date.now(),
          },
        ]);
      });
    },
    [doc, userName],
  );

  return (
    <Ctx.Provider
      value={{
        doc,
        userName,
        setUserName,
        sessionState,
        sessionName,
        peerCount,
        peers,
        errorMessage,
        hostSession,
        joinSession,
        leaveSession,
        getNode,
        getRootIds: getRootIdsFn,
        addNode,
        renameNode,
        toggleNode,
        setWeight,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
