import { StoreProvider, useYjsSnapshot, useStore } from "./store";
import { ConnectionPanel } from "./ConnectionPanel";
import { TreeNodeView, setPendingFocusId } from "./TreeNode";
import "./index.css";

function RoadmapEditor() {
  const { addNode, getRootIds } = useStore();
  useYjsSnapshot();

  const rootIds = getRootIds();

  const handleAddGoal = () => {
    const id = addNode(null, "goal", "");
    setPendingFocusId(id);
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
      <div className="pt-2 border-t border-dashed">
        <button
          onClick={handleAddGoal}
          className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          + Add Goal
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
