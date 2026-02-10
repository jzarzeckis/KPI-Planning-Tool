import { useState } from "react";
import { useStore, type PeerInfo } from "./store";

// ---------------------------------------------------------------------------
// Peer status chip
// ---------------------------------------------------------------------------

const statusConfig = {
  connecting: {
    dot: "bg-amber-400",
    text: "text-amber-700",
    bg: "bg-amber-50 border-amber-200",
    label: "Connecting",
  },
  connected: {
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
    label: "Connected",
  },
  disconnected: {
    dot: "bg-gray-400",
    text: "text-gray-500",
    bg: "bg-gray-50 border-gray-200",
    label: "Disconnected",
  },
} as const;

function PeerStatusChip({ peer }: { peer: PeerInfo }) {
  const cfg = statusConfig[peer.status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot} ${peer.status === "connecting" ? "animate-pulse" : ""}`}
      />
      <span className="font-mono truncate max-w-[6rem]">
        {peer.peerId.slice(0, 8)}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ConnectionPanel
// ---------------------------------------------------------------------------

export function ConnectionPanel() {
  const {
    userName,
    setUserName,
    sessionState,
    sessionName,
    peerCount,
    peers,
    errorMessage,
    connectToSession,
    leaveSession,
  } = useStore();

  const [nameInput, setNameInput] = useState("");

  const handleConnect = async () => {
    if (!nameInput.trim()) return;
    await connectToSession(nameInput.trim());
    setNameInput("");
  };

  // Connected / hosting state
  if (sessionState === "hosting" || sessionState === "connected") {
    return (
      <div className="rounded-lg border bg-card text-sm">
        <div className="flex items-center gap-3 px-4 py-2 flex-wrap">
          <span className="font-medium text-emerald-600">
            {sessionState === "hosting" ? "Hosting" : "Connected"}
          </span>
          <span className="text-muted-foreground">session</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">
            {sessionName}
          </code>
          <span className="text-muted-foreground text-xs">
            {peerCount} peer{peerCount !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground">as</span>
          <input
            className="bg-transparent border-b border-dashed border-muted-foreground/40 px-1 py-0.5 text-sm font-medium outline-none focus:border-primary w-32"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <button
            onClick={leaveSession}
            className="ml-auto rounded-md border px-2 py-1 text-xs hover:bg-accent transition-colors"
          >
            Leave
          </button>
        </div>
        {peers.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap px-4 pb-2">
            {peers.map((p) => (
              <PeerStatusChip key={p.peerId} peer={p} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Connecting state
  if (sessionState === "connecting") {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-card text-sm">
        <span className="text-amber-500 font-medium animate-pulse">
          Connecting...
        </span>
        {sessionName && (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {sessionName}
          </code>
        )}
        <button
          onClick={leaveSession}
          className="ml-auto rounded-md border px-2 py-1 text-xs hover:bg-accent transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  // Idle — single input to enter session name
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Not connected
        </span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Your name:</span>
          <input
            className="bg-transparent border-b border-dashed border-muted-foreground/40 px-1 py-0.5 text-sm font-medium outline-none focus:border-primary w-32"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          Enter a session name to host or join:
        </label>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. q1-planning"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConnect();
            }}
          />
          <button
            onClick={handleConnect}
            disabled={!nameInput.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
