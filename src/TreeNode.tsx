import { useState } from "react";
import {
  useYjsSnapshot,
  useStore,
  type NodeKind,
  type TreeNode as TNode,
} from "./store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const kindLabels: Record<NodeKind, string> = {
  goal: "Goal",
  kpi: "KPI",
  initiative: "Initiative",
};

const childKind: Record<NodeKind, NodeKind> = {
  goal: "kpi",
  kpi: "initiative",
  initiative: "kpi",
};

const kindColors: Record<NodeKind, string> = {
  goal: "border-l-blue-500",
  kpi: "border-l-amber-500",
  initiative: "border-l-emerald-500",
};

const kindBadgeColors: Record<NodeKind, string> = {
  goal: "bg-blue-100 text-blue-700",
  kpi: "bg-amber-100 text-amber-700",
  initiative: "bg-emerald-100 text-emerald-700",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TreeNodeView({
  nodeId,
  depth = 0,
}: {
  nodeId: string;
  depth?: number;
}) {
  const { getNode, addNode, renameNode, toggleNode, setWeight } = useStore();
  useYjsSnapshot();

  const node = getNode(nodeId);
  if (!node) return null;

  return (
    <TreeNodeInner
      node={node}
      depth={depth}
      addNode={addNode}
      renameNode={renameNode}
      toggleNode={toggleNode}
      setWeight={setWeight}
    />
  );
}

function TreeNodeInner({
  node,
  depth,
  addNode,
  renameNode,
  toggleNode,
  setWeight,
}: {
  node: TNode;
  depth: number;
  addNode: (parentId: string | null, kind: NodeKind, name: string) => string;
  renameNode: (id: string, name: string) => void;
  toggleNode: (id: string) => void;
  setWeight: (id: string, w: number) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(node.name);
  const [showLog, setShowLog] = useState(false);
  const [newChildName, setNewChildName] = useState("");
  const [showAddChild, setShowAddChild] = useState(false);

  const nextKind = childKind[node.kind];

  const handleRename = () => {
    if (draft.trim() && draft !== node.name) {
      renameNode(node.id, draft.trim());
    }
    setIsEditing(false);
  };

  const handleAddChild = () => {
    if (!newChildName.trim()) return;
    addNode(node.id, nextKind, newChildName.trim());
    setNewChildName("");
    setShowAddChild(false);
  };

  return (
    <div
      className={`border-l-2 ${kindColors[node.kind]} ${!node.enabled ? "opacity-50" : ""}`}
      style={{ marginLeft: depth > 0 ? 16 : 0 }}
    >
      <div className="group py-2 pl-3 pr-2">
        {/* Header row */}
        <div className="flex items-center gap-2 min-h-[32px]">
          {/* Toggle */}
          <button
            onClick={() => toggleNode(node.id)}
            className={`flex-shrink-0 w-4 h-4 rounded border text-[10px] leading-none flex items-center justify-center transition-colors ${
              node.enabled
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/40"
            }`}
            title={node.enabled ? "Disable" : "Enable"}
          >
            {node.enabled ? "✓" : ""}
          </button>

          {/* Kind badge */}
          <span
            className={`flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${kindBadgeColors[node.kind]}`}
          >
            {kindLabels[node.kind]}
          </span>

          {/* Name */}
          {isEditing ? (
            <input
              className="flex-1 bg-transparent border-b border-primary px-1 py-0.5 text-sm font-medium outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") {
                  setDraft(node.name);
                  setIsEditing(false);
                }
              }}
              autoFocus
            />
          ) : (
            <span
              className="flex-1 text-sm font-medium cursor-pointer hover:underline truncate"
              onClick={() => {
                setDraft(node.name);
                setIsEditing(true);
              }}
              title="Click to rename"
            >
              {node.name}
            </span>
          )}

          {/* Weight slider (only for KPIs) */}
          {node.kind === "kpi" && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(node.weight * 100)}
                onChange={(e) =>
                  setWeight(node.id, Number(e.target.value) / 100)
                }
                className="w-16 h-1 accent-amber-500"
              />
              <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
                {Math.round(node.weight * 100)}%
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => setShowAddChild(!showAddChild)}
              className="rounded p-1 text-xs hover:bg-accent transition-colors"
              title={`Add ${kindLabels[nextKind]}`}
            >
              +
            </button>
            <button
              onClick={() => setShowLog(!showLog)}
              className="rounded p-1 text-xs hover:bg-accent transition-colors"
              title="View log"
            >
              ℹ
            </button>
          </div>
        </div>

        {/* Add child inline */}
        {showAddChild && (
          <div className="flex items-center gap-1.5 mt-2 ml-6">
            <span className="text-xs text-muted-foreground">
              New {kindLabels[nextKind].toLowerCase()}:
            </span>
            <input
              className="flex-1 rounded border px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
              placeholder={`${kindLabels[nextKind]} name...`}
              value={newChildName}
              onChange={(e) => setNewChildName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddChild();
                if (e.key === "Escape") setShowAddChild(false);
              }}
              autoFocus
            />
            <button
              onClick={handleAddChild}
              disabled={!newChildName.trim()}
              className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              Add
            </button>
          </div>
        )}

        {/* Action log */}
        {showLog && node.log.length > 0 && (
          <div className="mt-2 ml-6 space-y-0.5 max-h-32 overflow-y-auto">
            {node.log.map((entry, i) => (
              <div
                key={i}
                className="text-[11px] text-muted-foreground leading-tight"
              >
                <span className="font-medium">{entry.user}</span>{" "}
                <span>{entry.action}</span>{" "}
                <span className="opacity-60">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Children */}
      {node.childIds.length > 0 && (
        <div className="ml-1">
          {node.childIds.map((childId) => (
            <TreeNodeView key={childId} nodeId={childId} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
