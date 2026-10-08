import clsx from "clsx";
import { Boxes, Cpu, Database, FlaskConical, Moon, SlidersHorizontal, Sun, Zap } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useApp, type Route } from "../lib/app";

type Item = { page: Route["page"]; label: string; icon: ReactNode; match: Route["page"][]; badge?: string };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Classify",
    items: [
      { page: "quick", label: "Quick Check", icon: <Zap />, match: ["quick"] },
      { page: "datasets", label: "Datasets", icon: <Database />, match: ["datasets", "dataset"] },
      { page: "experiments", label: "Experiments", icon: <FlaskConical />, match: ["experiments", "experiment", "new-experiment"] },
    ],
  },
  {
    title: "Models",
    items: [
      { page: "models", label: "Library", icon: <Boxes />, match: ["models"] },
      { page: "finetune", label: "Fine-tune", icon: <SlidersHorizontal />, match: ["finetune"], badge: "Preview" },
      { page: "engine", label: "Engine", icon: <Cpu />, match: ["engine"] },
    ],
  },
];

export function Sidebar({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const { route, go, engine, pulls } = useApp();
  const pulling = Object.keys(pulls).length;
  const navRef = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);

  // A single selection highlight that glides between items.
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>("[data-active=true]");
    setHl(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [route.page]);

  return (
    <aside className="sidebar flex w-[212px] shrink-0 flex-col border-r border-border">
      <div className="titlebar h-[52px] shrink-0" data-tauri-drag-region />

      <nav ref={navRef} className="relative flex-1 px-2.5">
        {hl && (
          <div
            className="absolute inset-x-2.5 rounded-[6px] bg-sel transition-[top,height] duration-300 ease-[var(--ease-out)]"
            style={{ top: hl.top, height: hl.height }}
          />
        )}
        {SECTIONS.map((s) => (
          <div key={s.title} className="mb-3">
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold text-faint">{s.title}</div>
            {s.items.map((n) => {
              const active = n.match.includes(route.page);
              return (
                <button
                  key={n.page}
                  data-active={active}
                  onClick={() => go({ page: n.page } as Route)}
                  className="relative flex h-[28px] w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-foreground"
                >
                  <span className={clsx("[&_svg]:size-[15px] [&_svg]:stroke-[1.75] transition-colors", active ? "text-primary" : "text-muted-foreground")}>{n.icon}</span>
                  {n.label}
                  {n.badge && <span className="ml-auto text-[10.5px] text-faint">{n.badge}</span>}
                  {n.page === "models" && pulling > 0 && (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-primary">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      {pulling}
                    </span>
                  )}
                  {n.page === "engine" && (
                    <span
                      className={clsx("ml-auto size-[7px] rounded-full", engine?.running ? "bg-good" : engine?.installed ? "bg-warn" : "bg-bad")}
                      title={engine?.running ? "Running" : engine?.installed ? "Stopped" : "Not installed"}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-between px-4 pb-3">
        <span className="text-[11px] text-faint">ClassifAI 0.1</span>
        <button onClick={toggleDark} className="grid size-6 place-items-center rounded-[5px] text-muted-foreground hover:bg-sel hover:text-foreground" title="Toggle appearance">
          {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
      </div>
    </aside>
  );
}
