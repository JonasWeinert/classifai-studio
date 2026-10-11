// Long text cut after a few lines, with More / Less. Expansion can be controlled (e.g. by a
// keyboard shortcut) or left to the component.
import { cn } from "@/lib/utils";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Clamp({
  children,
  lines = 2,
  expanded,
  onExpandedChange,
  toggleable = true,
  hint,
  className,
}: {
  children: ReactNode;
  lines?: number;
  expanded?: boolean;
  onExpandedChange?: (v: boolean) => void;
  /** Click the text or More to expand. Off inside clickable parents (e.g. option buttons). */
  toggleable?: boolean;
  /** Shortcut shown next to More, e.g. "C". */
  hint?: string;
  className?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = expanded ?? own;
  const set = (v: boolean) => (onExpandedChange ? onExpandedChange(v) : setOwn(v));
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  // Measure while collapsed: does the text run past the clamp?
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children, lines]);

  const can = toggleable && (overflows || open);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    set(!open);
  };
  return (
    <div className={className}>
      <div
        ref={ref}
        onClick={can ? toggle : undefined}
        className={cn("break-words whitespace-pre-wrap", can && "cursor-pointer")}
        style={open ? undefined : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {children}
      </div>
      {can && (
        <button onClick={toggle} className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
          {open ? "Less" : "More"}
          {hint && <kbd className="rounded-[3px] bg-primary/10 px-1 font-mono text-[10px] no-underline">{hint}</kbd>}
        </button>
      )}
    </div>
  );
}
