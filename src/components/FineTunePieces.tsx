// Pieces shared by the fine-tune pages: status, the trainer setup, the loss chart and estimates.
import { Check, Cpu, Download, HardDrive, MemoryStick, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, events } from "../lib/api";
import { useApp } from "../lib/app";
import { describeError } from "../lib/errors";
import { bytes } from "../lib/format";
import type { FineTune, FineTuneBase, FineTuneStatus, TrainerStatus } from "../lib/types";
import { TRAINER } from "../lib/thirdParty";
import { Badge, Button, Card, Disclosure } from "./ui";

const STATUS: Record<FineTuneStatus, [string, "accent" | "good" | "warn" | "bad" | "neutral"]> = {
  queued: ["Waiting", "neutral"],
  preparing: ["Preparing", "accent"],
  baseline: ["Comparing", "accent"],
  training: ["Training", "accent"],
  evaluating: ["Testing", "accent"],
  ready: ["Ready", "good"],
  failed: ["Failed", "bad"],
  cancelled: ["Stopped", "warn"],
};

export const isActive = (s: FineTuneStatus) => s === "queued" || s === "preparing" || s === "baseline" || s === "training" || s === "evaluating";

export function FineTuneBadge({ status }: { status: FineTuneStatus }) {
  const [label, tone] = STATUS[status];
  return (
    <Badge tone={tone}>
      {isActive(status) && status !== "queued" && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      {label}
    </Badge>
  );
}

/** What the trainer is doing, in words. */
export function stageText(f: FineTune): string {
  switch (f.status) {
    case "queued":
      return "Waiting for the fine-tune before it to finish";
    case "preparing":
      return "Splitting the labelled rows";
    case "baseline":
      return "Comparison models answer the held-out rows";
    case "evaluating":
      return "Testing on the held-out rows";
    case "training":
      switch (f.progress.stage) {
        case "loading": {
          const d = f.progress.download;
          if (d && d.total > 0 && d.done < d.total) return `Downloading ${f.base_title} · ${mb(d.done)} of ${mb(d.total)}`;
          return d ? "Loading the base model" : "Checking for the base model";
        }
        case "baseline":
          return "Measuring the base model";
        case "training":
          return f.progress.total_steps ? `Training · step ${f.progress.step} of ${f.progress.total_steps}` : "Training";
        case "calibrating":
          return "Calibrating confidence";
        case "exporting":
          return "Saving the model";
      }
      return "Starting the trainer";
    default:
      return "";
  }
}

/** Overall progress 0–1 across the stages (training is most of it). */
export function overallProgress(f: FineTune): number {
  const p = f.progress;
  switch (f.status) {
    case "queued":
      return 0;
    case "preparing":
      return 0.02;
    case "baseline":
      return 0.05;
    case "training": {
      const base = { loading: 0.08, baseline: 0.1, training: 0.12, calibrating: 0.84, exporting: 0.88 }[p.stage ?? "loading"] ?? 0.08;
      // A first run spends most of the load downloading: let the bar move with it.
      if (p.stage === "loading" && p.download && p.download.total > 0) return 0.06 + 0.035 * Math.min(1, p.download.done / p.download.total);
      return p.stage === "training" && p.total_steps ? 0.12 + 0.72 * (p.step / p.total_steps) : base;
    }
    case "evaluating":
      return 0.94;
    default:
      return 1;
  }
}

/** Seconds left in the training loop, from the pace so far. */
export function trainingEta(f: FineTune): number | null {
  const p = f.progress;
  if (f.status !== "training" || p.stage !== "training" || p.step < 3 || !p.total_steps) return null;
  return (p.elapsed_s / p.step) * (p.total_steps - p.step);
}

export const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);

export function duration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Training time for a base, rows and passes, from the M2 Max rates (plus loading and export). */
export function estimateSeconds(base: FineTuneBase, records: number, epochs: number): number {
  return (base.seconds_per_1k_rows * records * epochs) / 1000 + (base.kind === "encoder" ? 60 : 180);
}

/** The trainer: what it is, whether this Mac can run it, and the one-time setup. */
export function TrainerSetup({ status, onChange, compact }: { status: TrainerStatus; onChange: (s: TrainerStatus) => void; compact?: boolean }) {
  const { toast } = useApp();
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const un = events.trainerLog((l) => setLog((prev) => [...prev.slice(-300), l]));
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const install = async () => {
    setInstalling(true);
    setLog([]);
    try {
      onChange(await api.trainerInstall());
      toast("The trainer is ready", "good");
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setInstalling(false);
    }
  };

  const lowDisk = status.disk_free_gb < 8;
  return (
    <Card className="px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-primary">
          <Cpu className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{status.supported ? "Set up the trainer" : "Fine-tuning isn't available on this Mac"}</div>
          {status.supported ? (
            <p className="mt-1 max-w-[46rem] text-[12.5px] leading-relaxed text-muted-foreground">
              Training runs on this Mac's GPU with Unsloth and Apple's MLX. The one-time setup installs Python, PyTorch, MLX and Unsloth and the llama.cpp server that runs your fine-tuned models
              into ClassifAI's own folder (about 1.5 GB, a few minutes). Nothing is installed system-wide{compact ? "." : ", and you can remove it again at the bottom of this page."}
            </p>
          ) : (
            <p className="mt-1 text-[12.5px] text-muted-foreground">{status.reason}</p>
          )}
          {status.supported && (
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <MemoryStick className="size-3.5" /> {Math.round(status.memory_gb)} GB memory
              </span>
              <span className={lowDisk ? "flex items-center gap-1.5 text-warn" : "flex items-center gap-1.5"}>
                <HardDrive className="size-3.5" /> {Math.round(status.disk_free_gb)} GB free{lowDisk && " — about 5 GB are needed for the trainer and a first model"}
              </span>
            </div>
          )}
          {status.supported && (
            <div className="mt-3">
              <Disclosure label="What gets installed, and the licences">
                <ul className="space-y-1 text-[12px]">
                  {TRAINER.map((p) => (
                    <li key={p.name} className="flex gap-3">
                      <span className="w-[11rem] shrink-0 font-medium">{p.name}</span>
                      <span className="min-w-0 flex-1 text-muted-foreground">{p.role}</span>
                      <span className="shrink-0 font-mono text-[11px] text-faint">{p.license}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11.5px] text-faint">{TRAINER[0].note}</p>
              </Disclosure>
            </div>
          )}
          {(installing || log.length > 0) && (
            <div ref={logRef} className="mt-3 max-h-36 overflow-y-auto rounded-[8px] bg-background/70 px-3 py-2 font-mono text-[11px] leading-[1.6] text-muted-foreground">
              {log.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
        {status.supported && (
          <Button variant="primary" icon={<Download className="size-3.5" />} loading={installing} onClick={install}>
            {installing ? "Setting up…" : status.outdated ? "Update trainer" : "Set up trainer"}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** One line for an installed trainer. */
export function TrainerInstalled({ status }: { status: TrainerStatus }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Check className="size-3.5 text-good" /> Trainer installed · {bytes(status.size_bytes)}
      {status.outdated && (
        <span className="ml-1 flex items-center gap-1 text-warn">
          <TriangleAlert className="size-3" /> update available
        </span>
      )}
    </span>
  );
}

/** Training loss over steps, smoothed a little; `total` fixes the x axis while training runs. */
export function LossChart({ loss, total, height = 150 }: { loss: [number, number][]; total: number; height?: number }) {
  // Drawn at the container's own width, so text stays crisp and the plot fills the column.
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="w-full">
      <LossPlot loss={loss} total={total} w={w} h={height} />
    </div>
  );
}

function LossPlot({ loss, total, w, h }: { loss: [number, number][]; total: number; w: number; h: number }) {
  const height = h;
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  if (loss.length === 0) {
    return (
      <div className="grid place-items-center text-[12px] text-faint" style={{ height }}>
        The loss curve appears after the first few steps.
      </div>
    );
  }
  const maxX = Math.max(total, loss[loss.length - 1][0], 1);
  const maxY = Math.max(...loss.map(([, l]) => l)) * 1.1;
  const x = (s: number) => pad.l + (s / maxX) * (w - pad.l - pad.r);
  const y = (l: number) => pad.t + (1 - l / maxY) * (h - pad.t - pad.b);
  const path = loss.map(([s, l], i) => `${i ? "L" : "M"}${x(s).toFixed(1)},${y(l).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1].map((t) => t * maxY);
  const last = loss[loss.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" role="img" aria-label="Training loss">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
          <text x={pad.l - 6} y={y(t) + 3.5} textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">
            {t.toFixed(t < 1 ? 2 : 1)}
          </text>
        </g>
      ))}
      <text x={w - pad.r} y={h - 4} textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">
        step {maxX}
      </text>
      <text x={pad.l} y={h - 4} className="fill-[var(--faint)] text-[10px]">
        0
      </text>
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={3} fill="var(--primary)" />
    </svg>
  );
}
