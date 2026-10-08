import { cn } from "@/lib/utils";
import { Boxes, Database, FlaskConical, Search, SlidersHorizontal, Zap } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useApp, type Route } from "../lib/app";
import { usd } from "../lib/format";

type Item = { page: Route["page"]; label: string; icon: ReactNode; match: Route["page"][]; badge?: string };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Classify",
    items: [
      { page: "quick", label: "Quick Check", icon: <Zap />, match: ["quick"] },
      { page: "datasets", label: "Datasets", icon: <Database />, match: ["datasets", "dataset"] },
      { page: "experiments", label: "Experiments", icon: <FlaskConical />, match: ["experiments", "experiment", "new-experiment", "compare", "review"] },
    ],
  },
  {
    title: "Models",
    items: [
      { page: "models", label: "Models", icon: <Boxes />, match: ["models"] },
      { page: "finetune", label: "Fine-tune", icon: <SlidersHorizontal />, match: ["finetune"], badge: "Preview" },
    ],
  },
];

export function Sidebar() {
  const { route, go, engine, models, cloudModels, pulls, budget } = useApp();
  const pulling = Object.keys(pulls).length;
  const navRef = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);

  // A single selection highlight that glides between items.
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>("[data-active=true]");
    setHl(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [route.page]);

  // ↑/↓ move between items like a source list; Enter/Space activates (native button behaviour).
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    next?.click();
    e.preventDefault();
  };

  const engineTone = engine?.running ? "bg-good" : engine?.installed ? "bg-warn" : "bg-bad";
  const over = budget?.ratio != null && budget.ratio >= 0.8;

  return (
    <aside className="sidebar flex w-[212px] shrink-0 flex-col border-r border-border">
      <div className="titlebar h-[52px] shrink-0" data-tauri-drag-region />

      <button
        onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
        className="mx-2.5 mb-3 flex h-[26px] items-center gap-2 rounded-[7px] bg-sel px-2 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <Search className="size-3.5" />
        Search
        <span className="ml-auto text-[11px] text-faint">⌘K</span>
      </button>

      <nav ref={navRef} className="relative flex-1 px-2.5" onKeyDown={onKeyDown} aria-label="Sections">
        {hl && (
          <div className="absolute inset-x-2.5 rounded-[6px] bg-sel transition-[top,height] duration-300 ease-[var(--ease-out)]" style={{ top: hl.top, height: hl.height }} />
        )}
        {SECTIONS.map((s) => (
          <div key={s.title} className="mb-3">
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold text-muted-foreground/80">{s.title}</div>
            {s.items.map((n) => {
              const active = n.match.includes(route.page);
              return (
                <button
                  key={n.page}
                  data-nav
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                  onClick={() => go({ page: n.page } as Route)}
                  className="relative flex h-[28px] w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={cn("[&_svg]:size-[15px] [&_svg]:stroke-[1.75] transition-colors", active ? "text-primary" : "text-muted-foreground")}>{n.icon}</span>
                  {n.label}
                  {n.badge && <span className="ml-auto text-[11px] text-muted-foreground/80">{n.badge}</span>}
                  {n.page === "models" && pulling > 0 && (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-primary">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      {pulling}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Status line: engine health, model counts, budget. Opens the relevant settings. */}
      <div className="space-y-0.5 px-2.5 pb-3">
        {over && budget && (
          <button onClick={() => go({ page: "settings", tab: "accounts" })} className={cn("flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[11.5px] hover:bg-sel", budget.exceeded ? "text-bad" : "text-warn")}>
            <span className={cn("size-[7px] rounded-full", budget.exceeded ? "bg-bad" : "bg-warn")} />
            {budget.exceeded ? "Cloud budget used up" : `Budget ${Math.round((budget.ratio ?? 0) * 100)}% · ${usd(budget.month_spend_usd)}`}
          </button>
        )}
        <button onClick={() => go({ page: "settings", tab: "engine" })} className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[11.5px] text-muted-foreground hover:bg-sel hover:text-foreground">
          <span className={cn("size-[7px] shrink-0 rounded-full", engineTone)} />
          <span className="min-w-0">
            <span className="block truncate">{engine?.running ? "Engine running" : engine?.installed ? "Engine stopped" : "Engine not installed"}</span>
            <span className="block truncate text-faint">
              {models.length} local · {cloudModels.length} cloud models
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
