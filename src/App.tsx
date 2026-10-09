import { AnimatedToastStack } from "@/components/motion/animated-toast-stack";
import { cn } from "@/lib/utils";
import { FileUp, PanelLeft } from "lucide-react";
import { Tooltip } from "./components/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { events, isTauri } from "./lib/api";
import { useApp, type Route } from "./lib/app";
import { ToolbarContext } from "./lib/toolbar";
import { useImportDataset } from "./lib/useImportDataset";
import { installWindowDrag } from "./lib/windowDrag";
import { Compare } from "./pages/Compare";
import { DatasetDetail } from "./pages/DatasetDetail";
import { Datasets } from "./pages/Datasets";
import { ExperimentDetail } from "./pages/ExperimentDetail";
import { Experiments } from "./pages/Experiments";
import { FineTune } from "./pages/FineTune";
import { Models } from "./pages/Models";
import { NewExperiment } from "./pages/NewExperiment";
import { Onboarding } from "./pages/Onboarding";
import { Bulk } from "./pages/Bulk";
import { Playground } from "./pages/Playground";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";

if (isTauri) {
  document.documentElement.classList.add("tauri");
  installWindowDrag();
}

function routeKey(r: Route) {
  return "id" in r ? `${r.page}:${r.id}` : r.page;
}

const NAV: Record<string, Route> = {
  "nav:quick": { page: "quick" },
  "nav:bulk": { page: "bulk" },
  "nav:datasets": { page: "datasets" },
  "nav:experiments": { page: "experiments" },
  "nav:models": { page: "models" },
};

const DATA_FILE = /\.(csv|tsv|json|jsonl|ndjson)$/i;

export default function App() {
  const { route, go, back, engine, models, cloudModels, toasts, dismissToast, sidebarOpen, toggleSidebar } = useApp();
  const imp = useImportDataset();
  const [skipOnboarding, setSkip] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => setScrolled(false), [route]);

  // One place for menu items, keyboard shortcuts and palette actions.
  const runAction = useCallback(
    (action: string) => {
      if (NAV[action]) return go(NAV[action]);
      if (action === "back") return back();
      if (action === "settings") return go({ page: "settings" });
      if (action === "new-experiment") return go({ page: "new-experiment" });
      if (action === "import") return imp.run();
      if (action === "palette") return setPaletteOpen(true);
      if (action === "toggle-sidebar") return toggleSidebar();
    },
    [back, go, imp, toggleSidebar],
  );

  // Native menu (Tauri) …
  useEffect(() => {
    const un = events.menu(runAction);
    return () => void un.then((f) => f());
  }, [runAction]);

  // … and the same shortcuts in the browser preview, where there is no native menu.
  const runRef = useRef(runAction);
  runRef.current = runAction;
  useEffect(() => {
    if (isTauri) return;
    const toggle = (e: KeyboardEvent) => {
      if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        runRef.current("toggle-sidebar");
      }
    };
    window.addEventListener("keydown", toggle);
    const keys: Record<string, string> = { "1": "nav:quick", "2": "nav:bulk", "3": "nav:datasets", "4": "nav:experiments", "5": "nav:models", "[": "back", ",": "settings", n: "new-experiment", o: "import" };
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const action = keys[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      runRef.current(action);
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener("keydown", toggle);
    };
  }, []);

  // Drop a data file anywhere on the window to import it.
  useEffect(() => {
    if (isTauri) {
      let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent((e) => {
            const p = e.payload;
            if (p.type === "enter" || p.type === "over") setDragging(true);
            else if (p.type === "leave") setDragging(false);
            else if (p.type === "drop") {
              setDragging(false);
              const file = p.paths.find((x) => DATA_FILE.test(x));
              if (file) imp.importPath(file);
            }
          })
          .then((f) => (unlisten = f)),
      );
      return () => unlisten?.();
    }
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => DATA_FILE.test(f.name));
      if (file) imp.importText(file.name.replace(DATA_FILE, ""), await file.text());
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First launch: no usable model yet — neither a running local engine with a model, nor a connected cloud model.
  const hasLocal = !!engine?.installed && !!engine.running && models.length > 0;
  const needsOnboarding = engine !== null && !hasLocal && cloudModels.length === 0 && !skipOnboarding;

  if (engine === null) {
    return <div className="h-full titlebar" />;
  }
  if (needsOnboarding && route.page !== "settings" && route.page !== "models") {
    return <Onboarding onSkip={() => setSkip(true)} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        {/* Unified toolbar: page title and actions share the bar with the window's drag area. */}
        <div
          ref={setToolbar}
          className={cn(
            "titlebar relative z-30 flex h-[52px] shrink-0 items-center gap-3 border-b pr-6 transition-[padding,background-color,border-color] duration-300 ease-[var(--ease-out)]",
            // With the sidebar hidden, leave room for the window's traffic lights.
            sidebarOpen ? "pl-4" : "pl-[84px]",
            scrolled ? "border-border bg-background/80 backdrop-blur-xl" : "border-transparent bg-background",
          )}
        >
          <Tooltip content={sidebarOpen ? "Hide sidebar (⌃⌘S)" : "Show sidebar (⌃⌘S)"} side="bottom">
            <button onClick={toggleSidebar} aria-label="Toggle sidebar" className="grid size-7 shrink-0 place-items-center rounded-[7px] text-muted-foreground hover:bg-sel hover:text-foreground">
              <PanelLeft className="size-[17px] stroke-[1.75]" />
            </button>
          </Tooltip>
        </div>
        <div id="main-scroll" className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
          <ToolbarContext.Provider value={toolbar}>
            <div key={routeKey(route)} className="page-in mx-auto max-w-[1160px] px-8 pb-16 pt-6">
              {route.page === "quick" && <Playground />}
              {route.page === "bulk" && <Bulk />}
              {route.page === "datasets" && <Datasets />}
              {route.page === "dataset" && <DatasetDetail id={route.id} />}
              {route.page === "new-experiment" && <NewExperiment datasetId={route.datasetId} />}
              {route.page === "experiments" && <Experiments />}
              {route.page === "experiment" && <ExperimentDetail id={route.id} />}
              {route.page === "compare" && <Compare a={route.a} b={route.b} />}
              {route.page === "review" && <Review id={route.id} question={route.question} />}
              {route.page === "models" && <Models />}
              {route.page === "finetune" && <FineTune />}
              {(route.page === "settings" || route.page === "engine") && <Settings />}
            </div>
          </ToolbarContext.Provider>
        </div>
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-[95] grid place-items-center rounded-[18px] border-2 border-dashed border-primary bg-primary/8 backdrop-blur-[2px]" style={{ animation: "fade-in 0.15s ease-out both" }}>
          <div className="flex flex-col items-center gap-2 text-primary">
            <FileUp className="size-8 stroke-[1.5]" />
            <div className="text-[14px] font-semibold">Drop to import dataset</div>
            <div className="text-[12px] opacity-80">CSV, TSV, JSON or JSONL</div>
          </div>
        </div>
      )}
      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} position="bottom-center" fixed />
    </div>
  );
}
