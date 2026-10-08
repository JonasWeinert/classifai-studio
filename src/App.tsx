import clsx from "clsx";
import { useEffect, useState } from "react";
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

export default function App() {
  const { route, engine, models, toasts } = useApp();
  const { dark, toggle } = useTheme();
  const [skipOnboarding, setSkip] = useState(false);

  // First launch: engine missing or no models yet.
  const needsOnboarding = engine !== null && (!engine.installed || !engine.running || models.length === 0) && !skipOnboarding;

  if (engine === null) {
    return <div className="h-full titlebar" data-tauri-drag-region />;
  }
  if (needsOnboarding && route.page !== "engine") {
    return <Onboarding onSkip={() => setSkip(true)} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar dark={dark} toggleDark={toggle} />
      <main id="main-scroll" className="relative flex-1 overflow-y-auto">
        <div className="titlebar sticky top-0 z-20 h-[28px]" data-tauri-drag-region />
        <div className="mx-auto max-w-[1180px] px-9 pb-16 pt-4">
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
      </main>
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "fade-up pointer-events-auto max-w-sm rounded-xl border px-3.5 py-2.5 text-[12.5px] shadow-lg backdrop-blur",
              t.tone === "good" && "border-good/30 bg-good-soft text-good",
              t.tone === "bad" && "border-bad/30 bg-bad-soft text-bad",
              t.tone === "neutral" && "border-line bg-panel text-fg",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
