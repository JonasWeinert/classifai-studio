import clsx from "clsx";
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
