/**
 * React context wiring a Yjs Y.Doc to WebRTC peers via server-assisted signaling.
 *
 * Architecture: Star topology. The host maintains a data channel to each joiner
 * and relays yjs updates between them. Joiners only connect to the host.
 *
 * Protocol: Host pre-creates WebRTC offers. Joiners read an offer instantly,
 * create an answer, and post it back. Only the host polls (for answers).
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
  | "connecting"
  | "hosting"
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
// Peer tracking
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

  connectToSession: (name: string) => Promise<void>;
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

  const hostIdRef = useRef<string | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // -- Broadcast to peers ---------------------------------------------------

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
      Y.applyUpdate(doc, data, "remote");
      broadcastUpdate(data, fromPeerId);
    },
    [doc, broadcastUpdate],
  );

  // -- Host: create a new offer and post it to the server -------------------

  const createAndPostOffer = useCallback(
    async (
      name: string,
      hostId: string,
    ): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel } | null> => {
      const peerId = crypto.randomUUID();

      // Track as connecting
      const entry: PeerEntry = {
        peerId,
        pc: null!,
        dc: null,
        status: "connecting",
      };
      peersRef.current.set(peerId, entry);
      updatePeersState();

      let pc: RTCPeerConnection;
      let dc: RTCDataChannel;
      let offerString: string;
      try {
        const result = await createOffer(
          makeHostOnMessage(peerId),
          () => {
            // onOpen
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
            // onClose
            const peer = peersRef.current.get(peerId);
            if (peer) {
              peer.pc.close();
              peer.status = "disconnected";
              peer.disconnectedAt = Date.now();
            }
            updatePeersState();
          },
        );
        pc = result.pc;
        dc = result.dc;
        offerString = result.offerString;
      } catch {
        peersRef.current.delete(peerId);
        updatePeersState();
        return null;
      }

      entry.pc = pc;
      entry.dc = dc;

      // Post offer to server (either create-session or replace-offer)
      const isFirst = !hostIdRef.current;
      if (isFirst) {
        hostIdRef.current = hostId;
        const res = await fetch("/api/signaling?action=create-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, hostId, offer: offerString }),
        });
        const data = await res.json();
        if (!data.ok) {
          pc.close();
          peersRef.current.delete(peerId);
          updatePeersState();
          return null;
        }
      } else {
        await fetch("/api/signaling?action=replace-offer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: name,
            hostId,
            offer: offerString,
          }),
        });
      }

      return { pc, dc };
    },
    [doc, makeHostOnMessage, updatePeersState],
  );

  // -- Host: poll for answers and cycle offers ------------------------------

  const startHostPolling = useCallback(
    (
      name: string,
      hostId: string,
      currentPc: RTCPeerConnection,
      currentPeerId: string,
    ) => {
      if (pollRef.current) clearInterval(pollRef.current);

      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(
            `/api/signaling?action=poll-answer&session=${encodeURIComponent(name)}&hostId=${encodeURIComponent(hostId)}`,
          );
          const d = await r.json();
          if (d.ok && d.peerId && d.answer) {
            // Complete handshake with current offer's PC
            const peer = peersRef.current.get(currentPeerId);
            if (peer && peer.pc === currentPc) {
              await acceptAnswer(currentPc, d.answer);
            }

            // Create next offer for the next joiner
            const next = await createAndPostOffer(name, hostId);
            if (next) {
              // Find the peerId of the new entry
              const newPeerId = [...peersRef.current.entries()].find(
                ([, e]) => e.pc === next.pc,
              )?.[0];
              if (newPeerId) {
                // Restart polling with new PC
                startHostPolling(name, hostId, next.pc, newPeerId);
              }
            }
          }
        } catch {
          // Retry on next poll
        }
      }, 1000);
    },
    [createAndPostOffer],
  );

  // -- Track active session for reconnect -----------------------------------

  const activeSessionRef = useRef<string | null>(null);
  const connectAttemptRef = useRef(0);

  // -- Connect to session (unified host/join) -------------------------------

  const connectToSession = useCallback(
    async (name: string) => {
      const attemptId = ++connectAttemptRef.current;
      const isStale = () =>
        connectAttemptRef.current !== attemptId ||
        activeSessionRef.current !== name;

      setSessionState("connecting");
      setErrorMessage(null);
      setSessionName(name);
      activeSessionRef.current = name;

      // Ask server if session exists
      let role: "host" | "joiner";
      let offer: string | undefined;
      try {
        const res = await fetch("/api/signaling?action=join-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!data.ok) {
          // Session busy (no offer ready), retry
          if (!isStale()) {
            setTimeout(() => {
              if (!isStale()) connectToSession(name);
            }, 1000);
          }
          return;
        }
        role = data.role;
        offer = data.offer;
      } catch {
        if (!isStale()) {
          setTimeout(() => {
            if (!isStale()) connectToSession(name);
          }, 3000);
        }
        return;
      }

      if (isStale()) return;

      if (role === "host") {
        // -- Become host --
        isHostRef.current = true;
        const hostId = crypto.randomUUID();

        const result = await createAndPostOffer(name, hostId);
        if (!result) {
          setSessionState("error");
          setErrorMessage("Failed to create session");
          return;
        }

        if (isStale()) {
          result.pc.close();
          return;
        }

        setSessionState("hosting");

        // Find peerId of the pending offer
        const peerId = [...peersRef.current.entries()].find(
          ([, e]) => e.pc === result.pc,
        )?.[0];
        if (peerId) {
          startHostPolling(name, hostId, result.pc, peerId);
        }
      } else {
        // -- Become joiner --
        isHostRef.current = false;
        const peerId = crypto.randomUUID();

        let answerString: string;
        let pc: RTCPeerConnection;
        let dcPromise: Promise<RTCDataChannel>;
        try {
          const result = await acceptOffer(
            offer!,
            (data) => Y.applyUpdate(doc, data, "remote"),
            () => {
              // onOpen
              if (isStale()) return;
              const hostEntry = peersRef.current.get("host");
              if (hostEntry) hostEntry.status = "connected";
              setSessionState("connected");
              updatePeersState();
            },
            () => {
              // onClose — reconnect
              if (isStale()) return;
              const hostEntry = peersRef.current.get("host");
              if (hostEntry) {
                hostEntry.status = "disconnected";
                hostEntry.disconnectedAt = Date.now();
              }
              updatePeersState();
              setSessionState("connecting");
              setTimeout(() => {
                if (!isStale()) connectToSession(name);
              }, 3000);
            },
          );
          answerString = result.answerString;
          pc = result.pc;
          dcPromise = result.dc;
        } catch {
          if (!isStale()) {
            setTimeout(() => {
              if (!isStale()) connectToSession(name);
            }, 3000);
          }
          return;
        }

        if (isStale()) {
          pc.close();
          return;
        }

        // Track host connection
        peersRef.current.set("host", {
          peerId: "host",
          pc,
          dc: null,
          status: "connecting",
        });
        updatePeersState();

        dcPromise.then((dc) => {
          const entry = peersRef.current.get("host");
          if (entry) entry.dc = dc;
        });

        // Submit answer — no polling needed, connection opens when host accepts
        try {
          await fetch("/api/signaling?action=submit-answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session: name,
              peerId,
              answer: answerString,
            }),
          });
        } catch {
          pc.close();
          peersRef.current.delete("host");
          updatePeersState();
          if (!isStale()) {
            setTimeout(() => {
              if (!isStale()) connectToSession(name);
            }, 3000);
          }
        }
      }
    },
    [doc, createAndPostOffer, startHostPolling, updatePeersState],
  );

  // -- Leave session --------------------------------------------------------

  const leaveSession = useCallback(() => {
    activeSessionRef.current = null;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    for (const peer of peersRef.current.values()) {
      peer.pc.close();
    }
    peersRef.current.clear();

    if (isHostRef.current && sessionName && hostIdRef.current) {
      fetch("/api/signaling?action=delete-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sessionName,
          hostId: hostIdRef.current,
        }),
      }).catch(() => {});
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
        connectToSession,
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
