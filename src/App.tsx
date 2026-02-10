import { useState } from "react";
import { StoreProvider, useYjsSnapshot, useStore } from "./store";
import { ConnectionPanel } from "./ConnectionPanel";
import { TreeNodeView } from "./TreeNode";
import "./index.css";

function RoadmapEditor() {
  const { addNode, getRootIds } = useStore();
  useYjsSnapshot();

  const [newGoalName, setNewGoalName] = useState("");
  const rootIds = getRootIds();

  const handleAddGoal = () => {
    if (!newGoalName.trim()) return;
    addNode(null, "goal", newGoalName.trim());
    setNewGoalName("");
  };

  return (
    <div className="space-y-3">
      {rootIds.length === 0 && (
        <p className="text-sm text-muted-foreground italic py-4 text-center">
          No goals yet. Add your first roadmap goal below.
        </p>
      )}

      {rootIds.map((id) => (
        <TreeNodeView key={id} nodeId={id} />
      ))}

      {/* Add root goal */}
      <div className="flex items-center gap-2 pt-2 border-t border-dashed">
        <input
          className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          placeholder="New goal name..."
          value={newGoalName}
          onChange={(e) => setNewGoalName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddGoal();
          }}
        />
        <button
          onClick={handleAddGoal}
          disabled={!newGoalName.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          Add Goal
        </button>
      </div>
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
        <header>
          <h1 className="text-xl font-bold tracking-tight">
            Roadmap & KPI Planner
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time collaborative roadmap editing with CRDTs over WebRTC
          </p>
        </header>

        <ConnectionPanel />

        <section className="rounded-lg border bg-card p-4">
          <RoadmapEditor />
        </section>
      </div>
    </StoreProvider>
  );
}

export default App;
