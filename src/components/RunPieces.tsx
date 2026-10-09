// Shared bits of the Playground and Bulk pages: run hint, empty state, outdated banner.
import { CornerDownLeft } from "lucide-react";
import { Kbd } from "./ui";

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
