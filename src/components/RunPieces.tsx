// Shared bits of the Playground and Bulk pages: run hint, empty state, outdated banner.
import { CornerDownLeft } from "lucide-react";
import type { ReactNode } from "react";
import { shortModel } from "../lib/format";
import { useElapsed } from "../lib/modelStatus";
import { Kbd, Spinner } from "./ui";

/** A numbered step title: "① Entries". */
export function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary tnum">{n}</span>
      {children}
    </span>
  );
}

export function RunHint() {
  return (
    <span className="ml-1 flex items-center gap-0.5 opacity-70">
      <span className="text-[11px]">⌘</span>
      <CornerDownLeft className="size-3" />
    </span>
  );
}

export function EmptyResults({ hint = "Press Classify or" }: { hint?: string }) {
  return (
    <div className="grid min-h-[360px] place-items-center rounded-[14px] border border-dashed border-border-strong">
      <div className="text-center">
        <div className="text-[13px] font-medium text-muted-foreground">No results yet</div>
        <div className="mt-0.5 flex items-center justify-center gap-1 text-[12px] text-faint">
          {hint} <Kbd>⌘</Kbd>
          <Kbd>↩</Kbd>
        </div>
      </div>
    </div>
  );
}

export function OutdatedBanner({ onRun }: { onRun: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-[12px] bg-warn-soft px-4 py-2 text-[12.5px] text-warn fade-up">
      Inputs changed since these results.
      <button className="font-medium underline-offset-2 hover:underline" onClick={onRun}>
        Re-run ⌘↩
      </button>
    </div>
  );
}

/** "Loading laya into memory · 4 s" — a local model's warm-up before its first answer. */
export function ModelLoading({ model, since, compact }: { model: string; since: number | null; compact?: boolean }) {
  const s = useElapsed(since);
  return (
    <div className={compact ? "flex items-center gap-1.5 text-[11.5px] text-primary" : "flex items-start gap-2.5 rounded-[10px] bg-primary/8 px-3 py-2"}>
      <Spinner delay={0} className="text-primary" />
      <div className="min-w-0">
        <div className={compact ? "" : "text-[12.5px] font-medium text-primary"}>
          Loading {shortModel(model)} into memory{s > 0 && <span className="tnum"> · {s} s</span>}
        </div>
        {!compact && <div className="text-[11.5px] text-muted-foreground">The first request after a while loads the model; answers follow right after, and later ones are fast.</div>}
      </div>
    </div>
  );
}
