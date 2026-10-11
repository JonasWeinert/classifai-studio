// Side-by-side panes that fill the window's height and scroll independently, so a long left side
// never pushes the right side out of view (and the page itself does not scroll).
import { cn } from "@/lib/utils";
import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Height from an element's top to the bottom of the main scroll area (minus the page's bottom
 * padding), kept up to date as the window or the content above it changes. Below `min` px the page
 * scrolls as usual.
 */
export function useFillHeight<T extends HTMLElement>(min = 420) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const main = document.getElementById("main-scroll");
    const page = el.closest(".page-in");
    const measure = () => {
      const top = el.getBoundingClientRect().top + (main?.scrollTop ?? 0) - (main?.getBoundingClientRect().top ?? 0);
      const viewport = main?.clientHeight ?? window.innerHeight;
      const pad = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
      setHeight(Math.max(min, Math.floor(viewport - top - pad)));
    };
    measure();
    // Content above the panes (banners, headers) moves their top: watch the page and the window.
    const ro = new ResizeObserver(measure);
    if (page) ro.observe(page);
    if (main) ro.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [min]);
  return [ref, height] as const;
}

/** A grid of panes (`template` = CSS grid-template-columns); each child scrolls on its own. */
export function Panes({ template, children, className }: { template: string; children: ReactNode; className?: string }) {
  const [ref, height] = useFillHeight<HTMLDivElement>();
  return (
    <div ref={ref} data-fill-height className={cn("grid", className)} style={{ gridTemplateColumns: template, height: height ?? undefined }}>
      {Children.map(children, (child) =>
        child ? (
          // -mx/px keeps focus rings and shadows from being clipped by the scroll area.
          <div className="-mx-1.5 min-h-0 min-w-0 overflow-y-auto overscroll-contain px-1.5 pb-8">{child}</div>
        ) : null,
      )}
    </div>
  );
}
