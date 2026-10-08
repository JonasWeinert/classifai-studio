import clsx from "clsx";
import { Boxes, Cpu, Database, FlaskConical, Moon, Sparkles, Sun, Wand2, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useApp, type Route } from "../lib/app";

const NAV: { page: Route["page"]; label: string; icon: ReactNode; match: Route["page"][]; badge?: string }[] = [
  { page: "quick", label: "Quick check", icon: <Zap className="size-4" />, match: ["quick"] },
  { page: "datasets", label: "Datasets", icon: <Database className="size-4" />, match: ["datasets", "dataset"] },
  { page: "experiments", label: "Experiments", icon: <FlaskConical className="size-4" />, match: ["experiments", "experiment", "new-experiment"] },
  { page: "models", label: "Models", icon: <Boxes className="size-4" />, match: ["models"] },
  { page: "finetune", label: "Fine-tune", icon: <Wand2 className="size-4" />, match: ["finetune"], badge: "Soon" },
];

export function Sidebar({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const { route, go, engine, pulls } = useApp();
  const pulling = Object.keys(pulls).length;

  return (
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur">
      <div className="titlebar flex h-[60px] items-end px-5 pb-2.5" data-tauri-drag-region>
        <div className="ml-[62px] flex items-center gap-2" data-tauri-drag-region>
          <img src="/logo.svg" className="size-[22px]" alt="" />
          <span className="text-[14.5px] font-semibold tracking-[-0.02em]">ClassifAI</span>
        </div>
      </div>

      <nav className="mt-4 flex-1 space-y-0.5 px-3">
        {NAV.map((n) => {
          const active = n.match.includes(route.page);
          return (
            <button
              key={n.page}
              onClick={() => go({ page: n.page } as Route)}
              className={clsx(
                "group flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-2 hover:text-fg",
              )}
            >
              <span className={clsx(active ? "text-accent" : "text-faint group-hover:text-muted")}>{n.icon}</span>
              {n.label}
              {n.badge && <span className="ml-auto rounded bg-panel-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-faint">{n.badge}</span>}
              {n.page === "models" && pulling > 0 && (
                <span className="ml-auto flex items-center gap-1 text-[11px] text-accent">
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                  {pulling}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="m-3 space-y-2">
        <div className="rounded-xl border border-line bg-panel p-3">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <Sparkles className="size-3.5 text-accent" />
            Tip
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">Describe each label in a sentence — decision models read those descriptions and get noticeably more accurate.</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => go({ page: "engine" })}
            className={clsx(
              "flex h-8 flex-1 items-center gap-2 rounded-lg px-2.5 text-[12px] font-medium transition-colors",
              route.page === "engine" ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
            )}
          >
            <Cpu className="size-3.5" />
            Engine
            <span className="ml-auto flex items-center gap-1.5 text-[11px] font-normal">
              <span className={clsx("size-1.5 rounded-full", engine?.running ? "bg-good" : engine?.installed ? "bg-warn" : "bg-bad")} />
              {engine?.running ? "Running" : engine?.installed ? "Stopped" : "Not installed"}
            </span>
          </button>
          <button onClick={toggleDark} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg" title="Toggle theme">
            {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>
        </div>
      </div>
    </aside>
  );
}
