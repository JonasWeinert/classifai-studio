import { AnimatedToastStack } from "@/components/motion/animated-toast-stack";
import { cn } from "@/lib/utils";
import { ToolbarContext } from "./lib/toolbar";
import { useEffect, useState } from "react";
import { isTauri } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { useApp } from "./lib/app";
import { DatasetDetail } from "./pages/DatasetDetail";
import { Datasets } from "./pages/Datasets";
import { EnginePage } from "./pages/Engine";
import { ExperimentDetail } from "./pages/ExperimentDetail";
import { Experiments } from "./pages/Experiments";
import { FineTune } from "./pages/FineTune";
import { Models } from "./pages/Models";
import { NewExperiment } from "./pages/NewExperiment";
import { Onboarding } from "./pages/Onboarding";
import { QuickCheck } from "./pages/QuickCheck";

function useTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [pref, setPref] = useState<"system" | "light" | "dark">(() => {
    try {
      return (localStorage.getItem("theme") as "light" | "dark") ?? "system";
    } catch {
      return "system";
    }
  });
  const [sysDark, setSysDark] = useState(media.matches);
  useEffect(() => {
    const h = (e: MediaQueryListEvent) => setSysDark(e.matches);
    media.addEventListener("change", h);
    return () => media.removeEventListener("change", h);
  }, [media]);
  const dark = pref === "system" ? sysDark : pref === "dark";
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    setPref(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
  };
  return { dark, toggle };
}

if (isTauri) document.documentElement.classList.add("tauri");

function routeKey(r: ReturnType<typeof useApp>["route"]) {
  return "id" in r ? `${r.page}:${r.id}` : r.page;
}

export default function App() {
  const { route, engine, models, cloudModels, toasts, dismissToast } = useApp();
  const { dark, toggle } = useTheme();
  const [skipOnboarding, setSkip] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setScrolled(false), [route]);

  // First launch: no usable model yet — neither a running local engine with a model, nor a connected cloud model.
  const hasLocal = !!engine?.installed && !!engine.running && models.length > 0;
  const needsOnboarding = engine !== null && !hasLocal && cloudModels.length === 0 && !skipOnboarding;

  if (engine === null) {
    return <div className="h-full titlebar" data-tauri-drag-region />;
  }
  if (needsOnboarding && route.page !== "engine" && route.page !== "models") {
    return <Onboarding onSkip={() => setSkip(true)} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar dark={dark} toggleDark={toggle} />
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        {/* Unified toolbar: page title and actions share the bar with the window's drag area. */}
        <div
          ref={setToolbar}
          data-tauri-drag-region
          className={cn(
            "titlebar relative z-30 flex h-[52px] shrink-0 items-center gap-4 border-b px-6 transition-colors duration-200",
            scrolled ? "border-border bg-background/80 backdrop-blur-xl" : "border-transparent bg-background",
          )}
        />
        <div id="main-scroll" className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
          <ToolbarContext.Provider value={toolbar}>
            <div key={routeKey(route)} className="page-in mx-auto max-w-[1160px] px-8 pb-16 pt-6">
              {route.page === "quick" && <QuickCheck />}
              {route.page === "datasets" && <Datasets />}
              {route.page === "dataset" && <DatasetDetail id={route.id} />}
              {route.page === "new-experiment" && <NewExperiment datasetId={route.datasetId} />}
              {route.page === "experiments" && <Experiments />}
              {route.page === "experiment" && <ExperimentDetail id={route.id} />}
              {route.page === "models" && <Models />}
              {route.page === "finetune" && <FineTune />}
              {route.page === "engine" && <EnginePage />}
            </div>
          </ToolbarContext.Provider>
        </div>
      </main>
      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} position="bottom-center" fixed />
    </div>
  );
}
