// Manual labelling: select a passage of the entry and a small button appears next to it that adds
// the passage as context for the question being answered. The selection must lie inside one field
// (an element with `data-column`).
import { Quote } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { LabelSnippet } from "../lib/types";

const MAX_CHARS = 2000;

export function SelectionToContext({ container, target, color, onAdd }: { container: RefObject<HTMLElement | null>; target: string | null; color: string; onAdd: (s: LabelSnippet) => void }) {
  const [pick, setPick] = useState<{ snippet: LabelSnippet; x: number; y: number } | null>(null);

  useEffect(() => {
    const read = () => {
      const sel = window.getSelection();
      const root = container.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root) return setPick(null);
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return setPick(null);
      const node = range.commonAncestorContainer;
      const field = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-column]");
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (!field || !text || text.length > MAX_CHARS) return setPick(null);
      const r = range.getBoundingClientRect();
      setPick({ snippet: { column: field.dataset.column!, text }, x: r.left + r.width / 2, y: r.top });
    };
    // Read once the selection settles (mouse or keyboard), and drop it when it goes away.
    const onUp = () => setTimeout(read, 0);
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPick(null);
    };
    const hide = () => setPick(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    const scroller = container.current;
    scroller?.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
      scroller?.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [container]);

  if (!pick || !target) return null;
  const above = pick.y > 52;
  // On <body>: a transformed ancestor would otherwise shift `position: fixed`.
  return createPortal(
    <button
      // Keep the selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onAdd(pick.snippet);
        window.getSelection()?.removeAllRanges();
        setPick(null);
      }}
      style={{ left: pick.x, top: above ? pick.y - 8 : pick.y + 24, transform: `translate(-50%, ${above ? "-100%" : "0"})` }}
      className="fixed z-50 inline-flex max-w-[22rem] items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[12px] font-medium text-background shadow-lg fade-up"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <Quote className="size-3.5 shrink-0 opacity-70" />
      <span className="truncate">Add as context for “{target}”</span>
      <kbd className="ml-0.5 rounded-[4px] bg-background/20 px-1 font-mono text-[10.5px]">↵</kbd>
    </button>,
    document.body,
  );
}
