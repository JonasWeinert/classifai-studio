import clsx from "clsx";
import { useRef, useState } from "react";
import type { CalibrationBin } from "../lib/types";
import { pct } from "../lib/format";

/** Horizontal probability bars, highest first, with the winner highlighted. */
export function ProbBars({ probs, highlight, color = "var(--primary)", max = 8, legend }: { probs: Record<string, number>; highlight?: string; color?: string; max?: number; legend?: Record<string, string> }) {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, max);
  return (
    <div className="space-y-1.5">
      {shown.map(([k, v]) => {
        const win = k === highlight;
        return (
          <div key={k} className="grid grid-cols-[minmax(0,9rem)_1fr_3.2rem] items-center gap-2.5 text-[12.5px]">
            <div className={clsx("truncate", win ? "font-semibold text-foreground" : "text-muted-foreground")} title={legend?.[k] ?? k}>
              {legend ? <span className="mr-1 font-mono text-faint">{k}</span> : null}
              {legend?.[k] ?? k}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-card">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v * 100}%`, background: win ? color : "var(--border-strong)" }} />
            </div>
            <div className={clsx("text-right font-mono text-[11.5px] tnum", win ? "text-foreground" : "text-faint")}>{pct(v, 1)}</div>
          </div>
        );
      })}
      {entries.length > max && <div className="text-[11.5px] text-faint">+{entries.length - max} more</div>}
    </div>
  );
}

/** Row-normalized confusion matrix; cells show counts, shade shows recall share. */
export function ConfusionMatrix({ labels, matrix, color = "#7c5cff" }: { labels: string[]; matrix: number[][]; color?: string }) {
  const rowSums = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const cell = labels.length > 8 ? 30 : labels.length > 5 ? 40 : 52;
  return (
    <div className="overflow-auto">
      <div className="inline-block">
        <div className="flex">
          <div style={{ width: 110 }} />
          <div className="mb-1 text-center text-[10.5px] font-medium uppercase tracking-wider text-faint" style={{ width: cell * labels.length }}>
            Predicted
          </div>
        </div>
        <div className="flex">
          <div style={{ width: 110 }} />
          {labels.map((l) => (
            <div key={l} className="truncate px-0.5 pb-1 text-center text-[11px] text-muted-foreground" style={{ width: cell }} title={l}>
              {labels.length > 8 ? l.slice(0, 3) : l}
            </div>
          ))}
        </div>
        {labels.map((gt, i) => (
          <div key={gt} className="flex items-center">
            <div className="truncate pr-2 text-right text-[11.5px] text-muted-foreground" style={{ width: 110 }} title={gt}>
              {gt}
            </div>
            {labels.map((p, j) => {
              const n = matrix[i]?.[j] ?? 0;
              const share = rowSums[i] ? n / rowSums[i] : 0;
              const diag = i === j;
              return (
                <div
                  key={p}
                  className="m-px grid place-items-center rounded-[5px] font-mono text-[11px] tnum"
                  style={{
                    width: cell - 2,
                    height: cell - 2,
                    background: n === 0 ? "var(--card)" : diag ? `color-mix(in srgb, ${color} ${15 + share * 85}%, transparent)` : `color-mix(in srgb, var(--bad) ${10 + share * 70}%, transparent)`,
                    color: share > 0.55 ? "#fff" : n === 0 ? "var(--faint)" : "var(--foreground)",
                  }}
                  title={`${gt} → ${p}: ${n} (${pct(share)})`}
                >
                  {n}
                </div>
              );
            })}
          </div>
        ))}
        <div className="mt-1 flex">
          <div className="pr-2 text-right text-[10.5px] font-medium uppercase tracking-wider text-faint" style={{ width: 110 }}>
            ↑ Actual
          </div>
        </div>
      </div>
    </div>
  );
}

/** Reliability diagram: bars = observed accuracy per confidence bin, diagonal = perfect calibration. */
export function Reliability({ bins, color = "#7c5cff", size = 180 }: { bins: CalibrationBin[]; color?: string; size?: number }) {
  const pad = 22;
  const w = size,
    h = size;
  const inner = w - pad - 6;
  const total = bins.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <svg width={w} height={h + 4} className="overflow-visible">
      <rect x={pad} y={0} width={inner} height={inner} fill="var(--card)" rx={4} />
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={pad} x2={pad + inner} y1={inner * (1 - t)} y2={inner * (1 - t)} stroke="var(--border)" />
      ))}
      {bins.map((b, i) => {
        if (!b.count) return null;
        const x = pad + (i / bins.length) * inner + 1;
        const bw = inner / bins.length - 2;
        const bh = b.accuracy * inner;
        return (
          <rect key={i} x={x} y={inner - bh} width={bw} height={bh} rx={2} fill={color} opacity={0.35 + 0.65 * Math.min(1, (b.count / total) * 4)}>
            <title>{`confidence ${pct(b.lower, 0)}–${pct(b.upper, 0)}: accuracy ${pct(b.accuracy)} over ${b.count} rows`}</title>
          </rect>
        );
      })}
      <line x1={pad} y1={inner} x2={pad + inner} y2={0} stroke="var(--foreground)" strokeDasharray="3 3" opacity={0.35} />
      <text x={pad} y={inner + 14} fontSize={10} fill="var(--faint)">0</text>
      <text x={pad + inner} y={inner + 14} fontSize={10} fill="var(--faint)" textAnchor="end">confidence 1</text>
      <text x={pad - 5} y={8} fontSize={10} fill="var(--faint)" textAnchor="end">1</text>
      <text x={pad - 5} y={inner} fontSize={10} fill="var(--faint)" textAnchor="end">0</text>
    </svg>
  );
}

/** Compact vertical bar comparison of one metric across models. */
export function MetricBars({ items, format, higherIsBetter = true }: { items: { label: string; value: number; color: string }[]; format: (v: number) => string; higherIsBetter?: boolean }) {
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  const best = higherIsBetter ? Math.max(...items.map((i) => i.value)) : Math.min(...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.label} className="grid grid-cols-[minmax(0,8rem)_1fr_4.2rem] items-center gap-3">
          <div className="flex items-center gap-2 truncate text-[12.5px]">
            <span className="size-2 shrink-0 rounded-full" style={{ background: it.color }} />
            <span className="truncate">{it.label}</span>
          </div>
          <div className="h-5 overflow-hidden rounded-md bg-card">
            <div className="h-full rounded-md transition-[width] duration-500" style={{ width: `${(it.value / max) * 100}%`, background: it.color, opacity: it.value === best ? 1 : 0.55 }} />
          </div>
          <div className={clsx("text-right font-mono text-[12px] tnum", it.value === best ? "font-semibold text-foreground" : "text-muted-foreground")}>{format(it.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** Small distribution bar for label counts. */
export function Distribution({ items, total }: { items: { value: string; count: number }[]; total: number }) {
  return (
    <div className="space-y-1.5">
      {items.map((it) => (
        <div key={it.value} className="grid grid-cols-[minmax(0,10rem)_1fr_4rem] items-center gap-3 text-[12.5px]">
          <div className="truncate" title={it.value}>
            {it.value || <span className="italic text-faint">(empty)</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-card">
            <div className="h-full rounded-full bg-primary/70" style={{ width: `${(it.count / total) * 100}%` }} />
          </div>
          <div className="text-right font-mono text-[11.5px] text-muted-foreground tnum">{it.count}</div>
        </div>
      ))}
    </div>
  );
}

/** Precision / recall / F1 against the yes/no decision threshold, with markers for the selected and stored threshold. */
export function ThresholdChart({
  points,
  value,
  current,
  onPick,
  width = 560,
  height = 220,
}: {
  points: { threshold: number; precision: number; recall: number; f1: number }[];
  value: number;
  current: number;
  onPick?: (t: number) => void;
  width?: number;
  height?: number;
}) {
  const padL = 28,
    padB = 20,
    padT = 6,
    padR = 8;
  const iw = width - padL - padR,
    ih = height - padB - padT;
  const x = (t: number) => padL + t * iw;
  const y = (v: number) => padT + (1 - v) * ih;
  const series: { key: "precision" | "recall" | "f1"; color: string; label: string; dash?: string }[] = [
    { key: "precision", color: "var(--primary)", label: "Precision" },
    { key: "recall", color: "#f59e0b", label: "Recall", dash: "5 3" },
    { key: "f1", color: "var(--good)", label: "F1" },
  ];
  const path = (k: "precision" | "recall" | "f1") => points.map((p, i) => `${i ? "L" : "M"}${x(p.threshold).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  // Drag the threshold line (or click/drag anywhere on the plot): the line follows the pointer
  // continuously while `onPick` receives values snapped to 0.01, at most once per frame.
  const [drag, setDrag] = useState<number | null>(null);
  const frame = useRef(0);
  const clamp = (t: number) => Math.min(0.99, Math.max(0.01, t));
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp(((e.clientX - r.left) * (width / r.width) - padL) / iw);
  };
  const emit = (t: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => onPick?.(Math.round(t * 100) / 100));
  };
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onPick || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = at(e);
    setDrag(t);
    emit(t);
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const t = at(e);
    setDrag(t);
    emit(t);
  };
  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    emit(drag);
    setDrag(null);
  };
  const key = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!onPick || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.01;
    onPick(Math.round(clamp(value + (e.key === "ArrowRight" ? step : -step)) * 100) / 100);
  };
  const shown = drag ?? value;
  const lx = x(shown);
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width, touchAction: "none" }}
        className={clsx("max-w-full overflow-visible outline-none select-none", onPick && (drag !== null ? "cursor-grabbing" : "cursor-ew-resize"))}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        tabIndex={onPick ? 0 : undefined}
        role={onPick ? "slider" : undefined}
        aria-label="Decision threshold"
        aria-valuemin={0.01}
        aria-valuemax={0.99}
        aria-valuenow={value}
      >
        <rect x={padL} y={padT} width={iw} height={ih} fill="var(--card)" rx={4} />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={padL} x2={padL + iw} y1={y(t)} y2={y(t)} stroke="var(--border)" />
        ))}
        {series.map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />
        ))}
        <line x1={x(current)} x2={x(current)} y1={padT} y2={padT + ih} stroke="var(--faint)" strokeDasharray="2 3" />
        <g style={{ transform: `translateX(${lx}px)`, transition: drag === null ? "transform 0.18s var(--ease-out)" : "none" }}>
          <line x1={0} x2={0} y1={padT} y2={padT + ih} stroke="var(--foreground)" strokeWidth={drag !== null ? 2 : 1.5} />
          {onPick && (
            <>
              <rect x={-14} y={padT - 13} width={28} height={15} rx={7.5} fill="var(--foreground)" />
              <text x={0} y={padT - 2.5} fontSize={9.5} fill="var(--background)" textAnchor="middle" fontFamily="var(--font-mono, monospace)">
                {shown.toFixed(2)}
              </text>
              <circle cx={0} cy={padT + ih / 2} r={drag !== null ? 6 : 5} fill="var(--background)" stroke="var(--foreground)" strokeWidth={1.5} />
            </>
          )}
        </g>
        <text x={padL - 5} y={padT + 8} fontSize={10.5} fill="var(--faint)" textAnchor="end">1</text>
        <text x={padL - 5} y={padT + ih} fontSize={10.5} fill="var(--faint)" textAnchor="end">0</text>
        <text x={padL} y={height - 4} fontSize={10.5} fill="var(--faint)">0</text>
        <text x={padL + iw / 2} y={height - 4} fontSize={10.5} fill="var(--faint)" textAnchor="middle">threshold on P(yes)</text>
        <text x={padL + iw} y={height - 4} fontSize={10.5} fill="var(--faint)" textAnchor="end">1</text>
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-4 pl-7 text-[11.5px] text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <svg width="16" height="4">
              <line x1="0" x2="16" y1="2" y2="2" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ? "4 2" : undefined} />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10">
            <line x1="5" x2="5" y1="0" y2="10" stroke="var(--faint)" strokeDasharray="2 2" />
          </svg>
          stored
        </span>
      </div>
    </div>
  );
}

/** Heat colour for a 0–1 score (used by the cross-question table and κ matrices). */
export function heat(v: number) {
  const s = Math.max(0, Math.min(1, v));
  return `color-mix(in srgb, var(--primary) ${Math.round(8 + s * 62)}%, transparent)`;
}
