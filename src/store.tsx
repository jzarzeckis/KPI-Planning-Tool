/**
 * React context wiring a Yjs Y.Doc to WebRTC peers via server-assisted signaling.
 *
 * Architecture: Star topology. The host maintains a data channel to each joiner
 * and relays yjs updates between them. Joiners only connect to the host.
 *
 * Protocol: Host pre-creates WebRTC offers. Joiners read an offer instantly,
 * create an answer, and post it back. Only the host polls (for answers).
 *
 * Async flow: All session lifecycle (polling, retries, reconnects) is managed
 * via RxJS streams. A single Subscription controls the entire session —
 * unsubscribing tears down everything cleanly.
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
import {
  Subject,
  Subscription,
  defer,
  timer,
  from,
  EMPTY,
  Observable,
} from "rxjs";
import {
  switchMap,
  repeat,
  retry,
  finalize,
  debounceTime,
  tap,
  catchError,
} from "rxjs/operators";
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
  let binary = "";
  for (let i = 0; i < state.length; i++)
    binary += String.fromCharCode(state[i]!);
  localStorage.setItem(LS_KEY, btoa(binary));
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
// RTCPeerConnection disconnect detection
// ---------------------------------------------------------------------------

/** Returns an Observable that emits once when pc enters disconnected/failed state, then completes. */
function pcDisconnect$(pc: RTCPeerConnection): Observable<void> {
  return new Observable((subscriber) => {
    const handler = () => {
      const state = pc.connectionState;
      if (state === "disconnected" || state === "failed") {
        subscriber.next();
        subscriber.complete();
      }
    };
    pc.addEventListener("connectionstatechange", handler);
    // Check immediately in case already disconnected
    handler();
    return () => pc.removeEventListener("connectionstatechange", handler);
  });
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

  connectToSession: (name: string) => void;
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

  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const isHostRef = useRef(false);
  const hostIdRef = useRef<string | null>(null);
  const sessionSubRef = useRef<Subscription | null>(null);
  const sessionNameRef = useRef<string | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    loadFromLocalStorage(doc);
  }, [doc]);

  // -- Debounced localStorage persistence via RxJS --------------------------

  const update$ = useRef(new Subject<void>());

  useEffect(() => {
    const sub = update$.current
      .pipe(debounceTime(2000))
      .subscribe(() => saveToLocalStorage(doc));

    const handler = () => update$.current.next();
    doc.on("update", handler);

    return () => {
      doc.off("update", handler);
      sub.unsubscribe();
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

  // -- Helper: mark a peer as disconnected ----------------------------------

  const markDisconnected = useCallback(
    (peerId: string) => {
      const peer = peersRef.current.get(peerId);
      if (peer && peer.status !== "disconnected") {
        peer.pc.close();
        peer.status = "disconnected";
        peer.disconnectedAt = Date.now();
        updatePeersState();
      }
    },
    [updatePeersState],
  );

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
    ): Promise<{
      pc: RTCPeerConnection;
      dc: RTCDataChannel;
      peerId: string;
    } | null> => {
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
            // onOpen — send full state snapshot to new peer
            const peer = peersRef.current.get(peerId);
            if (peer) {
              peer.status = "connected";
              if (peer.dc && peer.dc.readyState === "open") {
                peer.dc.send(Y.encodeStateAsUpdate(doc));
              }
            }
            updatePeersState();
          },
          () => markDisconnected(peerId),
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

      // Monitor RTCPeerConnection state for abrupt disconnects (tab close, network loss)
      pcDisconnect$(pc).subscribe(() => markDisconnected(peerId));

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
        const res = await fetch("/api/signaling?action=replace-offer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: name, hostId, offer: offerString }),
        });
        const data = await res.json();
        if (!data.ok) {
          console.warn("replace-offer failed:", data.error);
        }
      }

      return { pc, dc, peerId };
    },
    [doc, makeHostOnMessage, updatePeersState, markDisconnected],
  );

  // -- Host flow: poll for answers, complete handshake, cycle offers --------

  const createHostFlow = useCallback(
    (
      name: string,
      hostId: string,
      firstPeerId: string,
      firstPc: RTCPeerConnection,
    ) => {
      let currentPeerId = firstPeerId;
      let currentPc = firstPc;

      // Each emission: poll for answer, if found → handshake + new offer
      const poll$ = defer(async () => {
        const r = await fetch(
          `/api/signaling?action=poll-answer&session=${encodeURIComponent(name)}&hostId=${encodeURIComponent(hostId)}`,
        );
        return r.json();
      }).pipe(
        switchMap((d) => {
          if (d.ok && d.peerId && d.answer) {
            // Complete handshake, then create next offer
            const handshake = async () => {
              const peer = peersRef.current.get(currentPeerId);
              if (peer && peer.pc === currentPc) {
                await acceptAnswer(currentPc, d.answer);
              }
              const next = await createAndPostOffer(name, hostId);
              if (next) {
                currentPeerId = next.peerId;
                currentPc = next.pc;
              }
            };
            return handshake();
          }
          // No answer yet — wait 1s before next poll
          return timer(1000).pipe(switchMap(() => EMPTY));
        }),
        catchError(() => timer(1000).pipe(switchMap(() => EMPTY))), // retry on network error
        repeat(), // loop forever
      );

      return poll$;
    },
    [createAndPostOffer],
  );

  // -- Connect to session (unified host/join) via RxJS ----------------------

  const connectToSession = useCallback(
    (name: string) => {
      // Tear down any previous session
      sessionSubRef.current?.unsubscribe();

      // Clean up old peer connections
      for (const peer of peersRef.current.values()) peer.pc.close();
      peersRef.current.clear();

      setSessionState("connecting");
      setErrorMessage(null);
      setSessionName(name);
      sessionNameRef.current = name;
      isHostRef.current = false;
      hostIdRef.current = null;

      const session$: Observable<void> = defer(async () => {
        // Ask server if session exists
        const res = await fetch("/api/signaling?action=join-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        return data as {
          ok: boolean;
          role?: "host" | "joiner";
          offer?: string;
          error?: string;
        };
      }).pipe(
        switchMap((data) => {
          if (!data.ok) {
            // Session busy (no offer ready) — throw to trigger retry
            throw new Error(data.error || "Session busy");
          }

          if (data.role === "host") {
            const becomeHost = async () => {
              isHostRef.current = true;
              const hostId = crypto.randomUUID();

              const result = await createAndPostOffer(name, hostId);
              if (!result) {
                throw new Error("Failed to create session");
              }

              setSessionState("hosting");

              // Start host polling stream (runs until unsubscribed)
              return createHostFlow(name, hostId, result.peerId, result.pc);
            };
            return from(becomeHost()).pipe(switchMap((hostPoll$) => hostPoll$));
          }

          // -- Become joiner --
          if (!data.offer) {
            throw new Error("No offer from host");
          }

          const becomeJoiner = async () => {
            const peerId = crypto.randomUUID();
            const result = await acceptOffer(
              data.offer!,
              (msg) => Y.applyUpdate(doc, msg, "remote"),
              () => {
                // onOpen
                const hostEntry = peersRef.current.get("host");
                if (hostEntry) hostEntry.status = "connected";
                setSessionState("connected");
                updatePeersState();
              },
              () => {
                // onClose — mark disconnected, throw to trigger retry
                markDisconnected("host");
                setSessionState("connecting");
              },
            );

            // Track host connection
            peersRef.current.set("host", {
              peerId: "host",
              pc: result.pc,
              dc: null,
              status: "connecting",
            });
            updatePeersState();

            // Monitor RTCPeerConnection state for abrupt disconnects
            pcDisconnect$(result.pc).subscribe(() => {
              markDisconnected("host");
              setSessionState("connecting");
            });

            result.dc.then((dc) => {
              const entry = peersRef.current.get("host");
              if (entry) entry.dc = dc;
            });

            // Submit answer
            await fetch("/api/signaling?action=submit-answer", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                session: name,
                peerId,
                answer: result.answerString,
              }),
            });

            // Wait for pc disconnect, then throw to trigger reconnect
            return new Observable<void>((subscriber) => {
              const checkDisconnect = () => {
                const state = result.pc.connectionState;
                if (state === "disconnected" || state === "failed") {
                  subscriber.error(new Error("Peer disconnected"));
                }
              };
              result.pc.addEventListener(
                "connectionstatechange",
                checkDisconnect,
              );
              // Also handle data channel close
              const dcCloseHandler = () =>
                subscriber.error(new Error("Data channel closed"));
              result.dc.then((dc) => {
                dc.addEventListener("close", dcCloseHandler);
              });
              return () => {
                result.pc.removeEventListener(
                  "connectionstatechange",
                  checkDisconnect,
                );
                result.pc.close();
                peersRef.current.delete("host");
                updatePeersState();
              };
            });
          };
          return from(becomeJoiner()).pipe(switchMap((inner$) => inner$));
        }),
        retry({
          delay: (error, retryCount) => {
            console.warn(
              `Session retry #${retryCount}:`,
              error?.message || error,
            );
            // Clean up old connections before retrying
            for (const peer of peersRef.current.values()) peer.pc.close();
            peersRef.current.clear();
            updatePeersState();
            setSessionState("connecting");
            isHostRef.current = false;
            hostIdRef.current = null;
            return timer(3000);
          },
        }),
        finalize(() => {
          // Runs on unsubscribe (leaveSession or unmount)
          for (const peer of peersRef.current.values()) peer.pc.close();
          peersRef.current.clear();
        }),
      );

      sessionSubRef.current = session$.subscribe({
        error: (err) => {
          console.error("Session stream error:", err);
          setSessionState("error");
          setErrorMessage(err?.message || "Connection failed");
        },
      });
    },
    [
      doc,
      createAndPostOffer,
      createHostFlow,
      updatePeersState,
      markDisconnected,
    ],
  );

  // -- Leave session --------------------------------------------------------

  const leaveSession = useCallback(() => {
    // Unsubscribe tears down everything (polls, PCs, retries) via finalize
    sessionSubRef.current?.unsubscribe();
    sessionSubRef.current = null;

    const wasHost = isHostRef.current;
    const name = sessionNameRef.current;
    const hostId = hostIdRef.current;

    if (wasHost && name && hostId) {
      fetch("/api/signaling?action=delete-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, hostId }),
      }).catch(() => {});
    }

    hostIdRef.current = null;
    sessionNameRef.current = null;
    isHostRef.current = false;
    setSessionState("idle");
    setSessionName(null);
    setPeerCount(0);
    setPeers([]);
    setErrorMessage(null);
  }, []);

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
      sessionSubRef.current?.unsubscribe();
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
            action: `Created ${kind}`,
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
      yNode.set("name", name);
    },
    [doc],
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
