// Visuals and explanations for a fine-tune: the stage pipeline with what each stage does, live
// training numbers, the loss curve, how much of the model changes, and what it learned (per label,
// confidence, and the rows it now gets right).
import { motion } from "motion/react";
import { BookOpen, BookOpenCheck, Download, FlaskConical, Gauge, GraduationCap, Ruler, Save, Scale, Shuffle, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { useApp } from "../lib/app";
import { pct } from "../lib/format";
import type { AnalysisRow, FineTune } from "../lib/types";
import { duration, trainingEta } from "./FineTunePieces";
import { Segmented } from "./ui";

// ---- stages -------------------------------------------------------------------------------

type StageKey = "split" | "compare" | "load" | "baseline" | "train" | "calibrate" | "save" | "test";
const STAGES: { key: StageKey; label: string; icon: ReactNode }[] = [
  { key: "split", label: "Split", icon: <Shuffle /> },
  { key: "compare", label: "Compare", icon: <Scale /> },
  { key: "load", label: "Load", icon: <Download /> },
  { key: "baseline", label: "Measure", icon: <Ruler /> },
  { key: "train", label: "Train", icon: <GraduationCap /> },
  { key: "calibrate", label: "Calibrate", icon: <Gauge /> },
  { key: "save", label: "Save", icon: <Save /> },
  { key: "test", label: "Test", icon: <FlaskConical /> },
];

export function stageOf(f: FineTune): number {
  switch (f.status) {
    case "queued":
    case "preparing":
      return 0;
    case "baseline":
      return 1;
    case "training":
      return { loading: 2, baseline: 3, training: 4, calibrating: 5, exporting: 6 }[f.progress.stage ?? "loading"] ?? 2;
    case "evaluating":
      return 7;
    default:
      return 8;
  }
}

const millions = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.round(n / 1e6)}M`);

/** What a stage does and why, with this fine-tune's numbers. */
function explain(key: StageKey, f: FineTune): { title: string; what: string; why: string } {
  const s = f.split;
  const batch = f.progress.batch_size || 8;
  switch (key) {
    case "split":
      return {
        title: "Splitting your labelled rows",
        what: s
          ? `The ${s.labelled.toLocaleString()} labelled rows are shuffled and split, keeping each label's share the same: ${s.test.toLocaleString()} locked away for the test, ${s.train.toLocaleString()} to learn from and ${s.calibration.toLocaleString()} to tune its confidence.`
          : "The labelled rows are shuffled and split into rows to learn from, rows to tune its confidence on, and rows locked away for the final test.",
        why: "Testing on rows the model never trained on is the only honest way to know whether it learned your task or just memorised examples.",
      };
    case "compare": {
      const models = f.config?.models ?? [];
      return {
        title: "Setting the bar to beat",
        what: models.length
          ? `${models.join(", ")} answer${models.length === 1 ? "s" : ""} the ${s?.test.toLocaleString() ?? ""} held-out rows, as a regular evaluation. The fine-tune joins the same evaluation once it's trained.`
          : "No comparison models were picked, so this step is skipped.",
        why: "Measuring the alternatives on exactly the rows the fine-tune will be tested on is what makes the before-and-after fair.",
      };
    }
    case "load":
      return {
        title: `Loading ${f.base_title}`,
        what: "The base model is read into this Mac's GPU memory. The first time, its weights are downloaded from Hugging Face; after that it starts in seconds.",
        why: "Fine-tuning starts from a model that already understands language and decisions, so it only needs to learn what's specific to your task.",
      };
    case "baseline":
      return {
        title: "Measuring the starting point",
        what: `Before anything changes, the model answers the ${s?.calibration.toLocaleString() ?? ""} calibration rows. That's the “before” every later number is compared with.`,
        why: "Without a baseline you can't tell how much training helped — or whether it helped at all.",
      };
    case "train":
      return {
        title: "Learning from your labels",
        what: `Each step shows the model ${batch} labelled rows. It compares its answers with your labels and nudges its weights a little towards the right ones. The original weights stay frozen; only small adapters (LoRA) and the decision head change.`,
        why: "This is where it picks up your categories, your wording and your edge cases. The loss below measures how surprised it still is by the right answers.",
      };
    case "calibrate":
      return {
        title: "Tuning its confidence",
        what: "On the calibration rows it fits one “temperature” per question type, so that answers given with 80% confidence turn out right about 80% of the time.",
        why: "Calibrated confidence lets you trust thresholds: send sure answers straight through and only review the unsure ones. It doesn't change which answer wins.",
      };
    case "save":
      return {
        title: "Saving the model",
        what: "The adapters are merged into the model and saved as an 8-bit GGUF file that llama.cpp runs on this Mac, next to your Ollaya models.",
        why: "One self-contained file: it answers through the same API as every other decision model in the app.",
      };
    case "test":
      return {
        title: "Testing on unseen rows",
        what: `The fine-tune and the models it started from answer the ${s?.test.toLocaleString() ?? ""} held-out rows, as a regular evaluation.`,
        why: "These rows played no part in training, so this is a fair side-by-side comparison.",
      };
  }
}

/** The stages as a row of nodes, the current one pulsing, with what it does and why below. */
const DOC_TOPIC: Record<StageKey, string> = { split: "split", compare: "pipeline", load: "bases", baseline: "pipeline", train: "training", calibrate: "calibration", save: "under-the-hood", test: "results" };

export function StagePipeline({ f }: { f: FineTune }) {
  const { go } = useApp();
  const at = stageOf(f);
  const failed = f.status === "failed" || f.status === "cancelled";
  const shown = STAGES[Math.min(at, STAGES.length - 1)];
  const text = explain(shown.key, f);
  return (
    <div>
      <div className="flex items-center">
        {STAGES.map((s, i) => {
          const done = i < at;
          const current = i === at && !failed;
          return (
            <div key={s.key} className={cn("flex items-center", i > 0 && "flex-1")}>
              {i > 0 && (
                <div className="relative mx-1.5 h-[3px] flex-1 overflow-hidden rounded-full bg-sel">
                  <motion.div className="absolute inset-y-0 left-0 rounded-full bg-primary" initial={false} animate={{ width: done || current ? "100%" : "0%" }} transition={{ duration: 0.6, ease: "easeOut" }} />
                </div>
              )}
              <div className="flex flex-col items-center gap-1.5">
                <div className="relative">
                  {current && <span className="absolute inset-0 animate-ping rounded-full bg-primary/30" />}
                  <div
                    className={cn(
                      "relative grid size-9 place-items-center rounded-full transition-colors duration-300 [&_svg]:size-4",
                      done ? "bg-primary text-white" : current ? "bg-primary/15 text-primary ring-2 ring-primary" : i === at && failed ? "bg-bad-soft text-bad" : "bg-sel text-faint",
                    )}
                  >
                    {s.icon}
                  </div>
                </div>
                <span className={cn("text-[11px]", done || current ? "text-foreground" : "text-faint", current && "font-semibold")}>{s.label}</span>
              </div>
            </div>
          );
        })}
      </div>
      {at < STAGES.length && !failed && (
        <motion.div key={shown.key} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-6 rounded-[12px] bg-background/60 px-4 py-3.5">
          <div>
            <div className="text-[13.5px] font-semibold">{text.title}</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{text.what}</p>
          </div>
          <div className="border-l border-border pl-5">
            <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Why</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{text.why}</p>
            <button onClick={() => go({ page: "docs", topic: DOC_TOPIC[shown.key] })} className="mt-1.5 flex items-center gap-1 text-[11.5px] text-primary hover:underline">
              <BookOpen className="size-3" /> More in the guide
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ---- live numbers ---------------------------------------------------------------------------

/** Centred moving average (no lag); with few readings it is the readings themselves. */
function ema(points: [number, number][]): [number, number][] {
  const half = Math.floor(points.length / 24);
  if (half === 0) return points;
  return points.map(([s], i) => {
    const win = points.slice(Math.max(0, i - half), i + half + 1);
    return [s, win.reduce((a, [, l]) => a + l, 0) / win.length];
  });
}

/** How the loss is moving, in a sentence. */
export function lossTrend(loss: [number, number][]): { text: string; down: boolean | null } {
  if (loss.length < 4) return { text: "The first loss readings arrive after a few steps.", down: null };
  const n = Math.max(2, Math.floor(loss.length / 5));
  const mean = (xs: [number, number][]) => xs.reduce((a, [, l]) => a + l, 0) / xs.length;
  const recent = mean(loss.slice(-n));
  const before = mean(loss.slice(-2 * n, -n));
  const change = (recent - before) / Math.max(before, 1e-9);
  if (change < -0.25) return { text: "Falling fast: it's picking up the patterns in your labels.", down: true };
  if (change < -0.05) return { text: "Still falling, more slowly: it's refining what it learned.", down: true };
  if (change > 0.1) return { text: "A little higher than before. Some noise is normal with small batches; watch the overall trend.", down: false };
  return { text: "Levelling off: most of the learning is done.", down: null };
}

export function LiveStats({ f }: { f: FineTune }) {
  const p = f.progress;
  const batch = p.batch_size || 8;
  const totalRows = (p.records || f.split?.records || 0) * f.settings.epochs;
  const seen = Math.min(totalRows || Infinity, p.step * batch);
  const speed = p.elapsed_s > 0 ? seen / p.elapsed_s : 0;
  const eta = trainingEta(f);
  const smooth = ema(p.loss);
  const first = smooth[0]?.[1];
  const last = smooth[smooth.length - 1]?.[1];
  const tiles = [
    { label: "Rows seen", value: seen.toLocaleString(), sub: totalRows ? `of ${Math.round(totalRows).toLocaleString()}` : undefined },
    { label: "Speed", value: speed ? `${speed < 10 ? speed.toFixed(1) : Math.round(speed)}/s` : "—", sub: "rows per second" },
    { label: "Time left", value: eta != null ? duration(eta) : "—", sub: `${duration(p.elapsed_s)} so far` },
    {
      label: "Loss",
      value: last != null ? last.toFixed(3) : "—",
      sub: first != null && last != null && first > 0 ? `${Math.round((1 - last / first) * 100)}% lower than at the start` : "how wrong it still is",
    },
  ];
  return (
    <div className="grid grid-cols-4 gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[10px] bg-background/60 px-3.5 py-2.5">
          <div className="text-[11px] text-faint">{t.label}</div>
          <div className="mt-0.5 font-mono text-[17px] font-semibold tracking-[-0.02em] tnum">{t.value}</div>
          {t.sub && <div className="text-[11px] text-muted-foreground">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ---- loss chart -----------------------------------------------------------------------------

function useWidth<T extends HTMLElement>(initial = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Loss per step: raw readings as dots, a smoothed line with a soft fill, pass boundaries, a
 *  live point, and a read-out under the pointer. */
export function LossCurve({ loss, total, epochs, live, height = 190 }: { loss: [number, number][]; total: number; epochs: number; live?: boolean; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = height;
  const pad = { l: 40, r: 12, t: 22, b: 22 };
  const smooth = useMemo(() => ema(loss), [loss]);
  if (loss.length === 0) {
    return (
      <div ref={ref} className="grid place-items-center rounded-[10px] border border-dashed border-border text-[12px] text-faint" style={{ height: h }}>
        The loss curve draws itself as the model trains.
      </div>
    );
  }
  const maxX = Math.max(total, loss[loss.length - 1][0], 1);
  const maxY = niceMax(Math.max(...loss.map(([, l]) => l)));
  const x = (s: number) => pad.l + (s / maxX) * (w - pad.l - pad.r);
  const y = (l: number) => pad.t + (1 - l / maxY) * (h - pad.t - pad.b);
  const line = smooth.map(([s, l], i) => `${i ? "L" : "M"}${x(s).toFixed(1)},${y(l).toFixed(1)}`).join(" ");
  const area = `${line} L${x(smooth[smooth.length - 1][0]).toFixed(1)},${y(0)} L${x(smooth[0][0]).toFixed(1)},${y(0)} Z`;
  const perPass = epochs > 0 ? maxX / epochs : maxX;
  const passes = Math.ceil(epochs);
  const last = smooth[smooth.length - 1];
  const hv = hover != null ? loss[hover] : null;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const step = ((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * maxX;
    let best = 0;
    loss.forEach(([s], i) => {
      if (Math.abs(s - step) < Math.abs(loss[best][0] - step)) best = i;
    });
    setHover(best);
  };
  return (
    <div ref={ref} className="relative w-full">
      <svg width={w} height={h} className="block" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Training loss">
        <defs>
          <linearGradient id="loss-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t * maxY)} y2={y(t * maxY)} stroke="var(--border)" />
            <text x={pad.l - 7} y={y(t * maxY) + 3.5} textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">
              {(t * maxY).toFixed(maxY < 2 ? 2 : 1)}
            </text>
          </g>
        ))}
        {passes > 1 &&
          Array.from({ length: passes }, (_, k) => (
            <g key={k}>
              {k > 0 && <line x1={x(k * perPass)} x2={x(k * perPass)} y1={pad.t - 4} y2={h - pad.b} stroke="var(--border-strong)" strokeDasharray="3 4" />}
              <text x={x((k + 0.5) * perPass)} y={pad.t - 9} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">
                pass {k + 1}
              </text>
            </g>
          ))}
        <path d={area} fill="url(#loss-fill)" />
        {loss.map(([s, l], i) => (
          <circle key={i} cx={x(s)} cy={y(l)} r={1.6} fill="var(--primary)" opacity={0.28} />
        ))}
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last[0])} cy={y(last[1])} r={3.5} fill="var(--primary)" />
        {live && (
          <circle cx={x(last[0])} cy={y(last[1])} r={3.5} fill="none" stroke="var(--primary)" strokeWidth={1.5}>
            <animate attributeName="r" values="3.5;11;3.5" dur="1.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0;0.8" dur="1.8s" repeatCount="indefinite" />
          </circle>
        )}
        <text x={pad.l} y={h - 5} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">
          0
        </text>
        <text x={(pad.l + w - pad.r) / 2} y={h - 5} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">
          training step
        </text>
        <text x={w - pad.r} y={h - 5} textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">
          {Math.round(maxX)}
        </text>
        {hv && (
          <g>
            <line x1={x(hv[0])} x2={x(hv[0])} y1={pad.t} y2={h - pad.b} stroke="var(--foreground)" strokeOpacity={0.25} />
            <circle cx={x(hv[0])} cy={y(hv[1])} r={4} fill="var(--background)" stroke="var(--primary)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hv && (
        <div
          className="pointer-events-none absolute top-1 rounded-[8px] bg-popover px-2.5 py-1.5 text-[11px] shadow-md ring-1 ring-border"
          style={{ left: Math.min(Math.max(x(hv[0]) + 10, 0), w - 150) }}
        >
          <div className="font-mono font-semibold tnum">loss {hv[1].toFixed(3)}</div>
          <div className="text-muted-foreground">
            step {hv[0]}
            {passes > 1 && ` · pass ${Math.min(passes, Math.floor(hv[0] / perPass) + 1)}`}
            {smooth[hover!] && ` · smoothed ${smooth[hover!][1].toFixed(3)}`}
          </div>
        </div>
      )}
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 5 ? 5 : 10) * p;
}

export function LossTrendNote({ loss }: { loss: [number, number][] }) {
  const t = lossTrend(ema(loss));
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      {t.down === true ? <TrendingDown className="size-3.5 text-good" /> : t.down === false ? <TrendingUp className="size-3.5 text-warn" /> : null}
      {t.text}
    </div>
  );
}

// ---- how much changes -----------------------------------------------------------------------

/** 100 squares for the model's weights; the lit ones are what training changes. */
export function WeightsWaffle({ total, trainable, stacked }: { total: number; trainable: number; stacked?: boolean }) {
  const share = trainable / Math.max(total, 1);
  const lit = Math.max(1, Math.round(share * 100));
  return (
    <div className={cn("flex gap-4", stacked ? "flex-col" : "items-center")}>
      <div className="grid shrink-0 grid-cols-10 gap-[2.5px]">
        {Array.from({ length: 100 }, (_, i) => (
          <motion.span
            key={i}
            className={cn("size-[9px] rounded-[2.5px]", i < lit ? "bg-primary" : "bg-sel")}
            initial={i < lit ? { scale: 0.3, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: i * 0.02, duration: 0.25 }}
          />
        ))}
      </div>
      <div className="text-[12px] leading-relaxed text-muted-foreground">
        <div className="text-[13px] font-semibold text-foreground">
          {millions(trainable)} of {millions(total)} weights train
        </div>
        That's {share < 0.01 ? "under 1%" : pct(share, 0)}. The base model stays frozen; small adapters (LoRA) and the decision head learn your task. That keeps training fast and stops the model from forgetting what it already knew.
      </div>
    </div>
  );
}

// ---- what it learned ------------------------------------------------------------------------

const show = (v: string | boolean | null) => (v === true ? "yes" : v === false ? "no" : v ?? "—");

type Outcome = "learned" | "kept" | "unlearned" | "wrong";
const outcome = (r: AnalysisRow): Outcome => {
  const b = r.before === r.gold;
  const a = r.after === r.gold;
  return b && a ? "kept" : !b && a ? "learned" : b && !a ? "unlearned" : "wrong";
};

/** Calibration rows before and after: overall, per label, confidence, and examples. */
export function WhatItLearned({ rows }: { rows: AnalysisRow[] }) {
  const done = rows.filter((r) => r.before != null && r.after != null);
  const questions = [...new Set(done.map((r) => r.question))];
  const [q, setQ] = useState(questions[0] ?? "");
  const mine = done.filter((r) => r.question === q);
  if (done.length === 0) return null;
  return (
    <div className="space-y-8">
      {questions.length > 1 && <Segmented value={q} onChange={setQ} options={questions.map((x) => ({ value: x, label: x }))} />}
      <OutcomeBar rows={mine} />
      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-10">
        <PerLabel rows={mine} />
        <Reliability rows={mine} />
      </div>
      <Examples rows={mine} />
    </div>
  );
}

function OutcomeBar({ rows }: { rows: AnalysisRow[] }) {
  const n = rows.length;
  const count = (o: Outcome) => rows.filter((r) => outcome(r) === o).length;
  const before = rows.filter((r) => r.before === r.gold).length / n;
  const after = rows.filter((r) => r.after === r.gold).length / n;
  const parts: { o: Outcome; label: string; color: string; hint: string }[] = [
    { o: "kept", label: "right before and after", color: "color-mix(in oklab, var(--good) 45%, transparent)", hint: "" },
    { o: "learned", label: "learned", color: "var(--good)", hint: "wrong before, right now" },
    { o: "unlearned", label: "unlearned", color: "var(--bad)", hint: "right before, wrong now" },
    { o: "wrong", label: "still wrong", color: "var(--border-strong)", hint: "" },
  ];
  return (
    <div className="grid grid-cols-[14rem_minmax(0,1fr)] items-center gap-8">
      <div className="space-y-2.5">
        {[
          { label: "Before", v: before, color: "var(--faint)" },
          { label: "After", v: after, color: "var(--primary)" },
        ].map((b) => (
          <div key={b.label}>
            <div className="flex justify-between text-[11.5px]">
              <span className="text-muted-foreground">{b.label}</span>
              <span className="font-mono font-semibold tnum">{pct(b.v, 0)}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-sel">
              <motion.div className="h-full rounded-full" style={{ background: b.color }} initial={{ width: 0 }} animate={{ width: `${b.v * 100}%` }} transition={{ duration: 0.9, ease: "easeOut" }} />
            </div>
          </div>
        ))}
        <div className="text-[11px] text-faint">accuracy on {n} calibration rows</div>
      </div>
      <div>
        <div className="text-[13px]">
          <span className="font-semibold text-good">{count("learned")} rows learned</span>
          {count("unlearned") > 0 && (
            <>
              , <span className="font-semibold text-bad">{count("unlearned")} unlearned</span>
            </>
          )}
          <span className="text-muted-foreground"> — every calibration row, by what changed</span>
        </div>
        <div className="mt-2.5 flex h-6 overflow-hidden rounded-[7px]">
          {parts.map((p, i) => {
            const c = count(p.o);
            return c ? (
              <motion.div
                key={p.o}
                className="h-full border-r-2 border-background last:border-r-0"
                style={{ background: p.color }}
                initial={{ width: 0 }}
                animate={{ width: `${(c / n) * 100}%` }}
                transition={{ duration: 0.7, delay: 0.15 * i, ease: "easeOut" }}
                title={`${c} ${p.label}`}
              />
            ) : null;
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
          {parts.map((p) => (
            <span key={p.o} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: p.color }} />
              <span className="font-mono font-medium tnum">{count(p.o)}</span>
              <span className="text-muted-foreground">
                {p.label}
                {p.hint && <span className="text-faint"> ({p.hint})</span>}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Accuracy per gold label before and after, as dumbbells. */
function PerLabel({ rows }: { rows: AnalysisRow[] }) {
  const labels = [...new Set(rows.map((r) => show(r.gold)))];
  const stats = labels
    .map((l) => {
      const of = rows.filter((r) => show(r.gold) === l);
      return { l, n: of.length, b: of.filter((r) => r.before === r.gold).length / of.length, a: of.filter((r) => r.after === r.gold).length / of.length };
    })
    .sort((x, y) => y.a - y.b - (x.a - x.b));
  return (
    <div>
      <div className="text-[13px] font-semibold">Per label</div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">How often each label was recognised, before (grey) and after (blue). Biggest gains first.</div>
      <div className="mt-3 space-y-2">
        {stats.map((s, i) => (
          <div key={s.l} className="grid grid-cols-[minmax(0,7.5rem)_1fr_4.5rem] items-center gap-3 text-[12px]">
            <span className="truncate" title={s.l}>
              {s.l} <span className="text-faint">· {s.n}</span>
            </span>
            <div className="relative h-4">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
              <motion.div
                className={cn("absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full", s.a >= s.b ? "bg-good/60" : "bg-bad/60")}
                style={{ left: `${Math.min(s.a, s.b) * 100}%` }}
                initial={{ width: 0 }}
                animate={{ width: `${Math.abs(s.a - s.b) * 100}%` }}
                transition={{ duration: 0.6, delay: 0.05 * i }}
              />
              <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-faint ring-2 ring-background" style={{ left: `${s.b * 100}%` }} />
              <motion.span
                className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
                initial={{ left: `${s.b * 100}%` }}
                animate={{ left: `${s.a * 100}%` }}
                transition={{ duration: 0.6, delay: 0.05 * i }}
              />
            </div>
            <span className="text-right font-mono tnum">
              <span className="text-faint">{Math.round(s.b * 100)}</span>
              <span className="text-faint"> → </span>
              <span className={s.a > s.b ? "text-good" : s.a < s.b ? "text-bad" : ""}>{Math.round(s.a * 100)}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Confidence vs how often it was right, before and after. On the diagonal is perfect. */
function Reliability({ rows }: { rows: AnalysisRow[] }) {
  const [ref, w] = useWidth<HTMLDivElement>(320);
  const h = Math.min(220, w * 0.75);
  const pad = { l: 34, r: 10, t: 10, b: 28 };
  const bins = [0, 0.4, 0.55, 0.7, 0.85, 1.0001];
  const series = (which: "before" | "after") =>
    bins.slice(0, -1).flatMap((lo, i) => {
      const hi = bins[i + 1];
      const of = rows.filter((r) => {
        const p = which === "before" ? r.before_p : r.after_p;
        return p != null && p >= lo && p < hi;
      });
      if (of.length < 3) return [];
      const conf = of.reduce((a, r) => a + ((which === "before" ? r.before_p : r.after_p) ?? 0), 0) / of.length;
      const acc = of.filter((r) => (which === "before" ? r.before : r.after) === r.gold).length / of.length;
      return [{ conf, acc, n: of.length }];
    });
  const x = (v: number) => pad.l + v * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v) * (h - pad.t - pad.b);
  const path = (pts: { conf: number; acc: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.conf).toFixed(1)},${y(p.acc).toFixed(1)}`).join(" ");
  const before = series("before");
  const after = series("after");
  const r = (n: number) => 2.5 + Math.sqrt(n) * 0.9;
  return (
    <div>
      <div className="text-[13px] font-semibold">Confidence you can trust</div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">How sure it was against how often it was right. On the dashed line, 80% sure means right 80% of the time.</div>
      <div ref={ref} className="mt-2 w-full">
        <svg width={w} height={h} className="block" role="img" aria-label="Calibration before and after">
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--border)" />
              <text x={pad.l - 6} y={y(t) + 3.5} textAnchor="end" className="fill-[var(--faint)] text-[10px]">
                {t * 100}%
              </text>
              <text x={x(t)} y={h - 14} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">
                {t * 100}%
              </text>
            </g>
          ))}
          <text x={x(0.5)} y={h - 2} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">
            how sure it was
          </text>
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--faint)" strokeDasharray="4 4" />
          <path d={path(before)} fill="none" stroke="var(--faint)" strokeWidth={1.6} />
          {before.map((p, i) => (
            <circle key={`b${i}`} cx={x(p.conf)} cy={y(p.acc)} r={r(p.n)} fill="var(--faint)" fillOpacity={0.5} />
          ))}
          <motion.path d={path(after)} fill="none" stroke="var(--primary)" strokeWidth={2.2} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1 }} />
          {after.map((p, i) => (
            <circle key={`a${i}`} cx={x(p.conf)} cy={y(p.acc)} r={r(p.n)} fill="var(--primary)" fillOpacity={0.75} />
          ))}
        </svg>
      </div>
      <div className="mt-1 flex gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-faint" /> before
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-primary" /> after
        </span>
        <span className="text-faint">dot size: number of rows</span>
      </div>
    </div>
  );
}

function Examples({ rows }: { rows: AnalysisRow[] }) {
  const groups: Record<"learned" | "unlearned" | "wrong", AnalysisRow[]> = { learned: [], unlearned: [], wrong: [] };
  rows.forEach((r) => {
    const o = outcome(r);
    if (o !== "kept") groups[o].push(r);
  });
  const [tab, setTab] = useState<"learned" | "unlearned" | "wrong">("learned");
  const list = groups[tab].sort((a, b) => (b.after_p ?? 0) - (a.after_p ?? 0)).slice(0, 6);
  const blurb = {
    learned: "Rows it got wrong before training and gets right now.",
    unlearned: "Rows it got right before and wrong now. A few are normal; many would mean it over-fitted.",
    wrong: "Rows it still gets wrong. Often these are ambiguous, mislabelled, or need more examples of their label.",
  }[tab];
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            <BookOpenCheck className="size-4 text-primary" /> Rows, before and after
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">{blurb}</div>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "learned", label: `Learned · ${groups.learned.length}` },
            { value: "unlearned", label: `Unlearned · ${groups.unlearned.length}` },
            { value: "wrong", label: `Still wrong · ${groups.wrong.length}` },
          ]}
        />
      </div>
      {list.length === 0 ? (
        <div className="mt-4 text-[12.5px] text-faint">None.</div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {list.map((r, i) => (
            <motion.div key={`${tab}-${r.row}-${r.question}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="rounded-[12px] bg-card px-4 py-3">
              <p className="line-clamp-3 text-[12.5px] leading-relaxed">{r.text}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                <span className="text-faint">label</span>
                <span className="rounded-[5px] bg-sel px-1.5 py-0.5 font-medium">{show(r.gold)}</span>
                <span className="ml-auto flex items-center gap-1.5 font-mono tnum">
                  <span className={cn(r.before === r.gold ? "text-good" : "text-bad line-through decoration-1")}>{show(r.before)}</span>
                  <span className="text-faint">{r.before_p != null && pct(r.before_p, 0)}</span>
                  <span className="text-faint">→</span>
                  <span className={cn("font-semibold", r.after === r.gold ? "text-good" : "text-bad")}>{show(r.after)}</span>
                  <span className="text-faint">{r.after_p != null && pct(r.after_p, 0)}</span>
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- base model download ------------------------------------------------------------------

/** The base model's download while loading: bytes, speed, time left, files. Speed is smoothed
 *  over the last few readings so it doesn't jump with every chunk. */
export function DownloadPanel({ f }: { f: FineTune }) {
  const d = f.progress.download;
  const samples = useRef<{ t: number; done: number }[]>([]);
  const now = d ? { t: d.elapsed_s, done: d.done } : null;
  if (now && (samples.current.length === 0 || samples.current[samples.current.length - 1].t !== now.t)) {
    samples.current = [...samples.current.filter((s) => s.t <= now.t), now].slice(-8);
  }
  if (!d) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Download className="size-4 text-faint" /> Checking whether {f.base_title} is already downloaded…
      </div>
    );
  }
  if (d.error) {
    return <div className="text-[12.5px] text-muted-foreground">Couldn't check the download ({d.error}). Loading the base model directly.</div>;
  }
  if (d.total === 0) {
    return (
      <div className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
        <span className="grid size-7 place-items-center rounded-full bg-good-soft text-good">
          <Download className="size-3.5" />
        </span>
        {f.base_title} is already on this Mac ({mbText(d.cached)} in the Hugging Face cache). Loading it into memory…
      </div>
    );
  }
  const first = samples.current[0];
  const last = samples.current[samples.current.length - 1];
  const speed = last && first && last.t > first.t ? (last.done - first.done) / (last.t - first.t) : d.elapsed_s > 0 ? d.done / d.elapsed_s : 0;
  const left = speed > 0 ? (d.total - d.done) / speed : null;
  const frac = d.done / d.total;
  const finished = d.done >= d.total;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Download className="size-4 text-primary" />
          {finished ? `Downloaded ${f.base_title}` : `Downloading ${f.base_title}`}
        </div>
        <div className="font-mono text-[12px] tnum text-muted-foreground">
          {mbText(d.done)} <span className="text-faint">of</span> {mbText(d.total)}
        </div>
      </div>
      <div className="relative mt-2.5 h-2.5 overflow-hidden rounded-full bg-sel">
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-primary" animate={{ width: `${frac * 100}%` }} transition={{ duration: 0.4, ease: "easeOut" }} />
        {!finished && <div className="absolute inset-0 shimmer opacity-40" />}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-3">
        {[
          { label: "Progress", value: `${Math.floor(frac * 100)}%` },
          { label: "Speed", value: speed > 0 ? `${mbText(speed)}/s` : "—" },
          { label: finished ? "Took" : "Time left", value: finished ? duration(d.elapsed_s) : left != null ? duration(left) : "—" },
          { label: "Files", value: `${d.files_done} of ${d.files}` },
        ].map((t) => (
          <div key={t.label} className="rounded-[10px] bg-background/60 px-3.5 py-2">
            <div className="text-[11px] text-faint">{t.label}</div>
            <div className="mt-0.5 font-mono text-[15px] font-semibold tnum">{t.value}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-faint">
        Weights come from Hugging Face ({f.base_title}) and are kept in its cache, so later fine-tunes of this base start in seconds.
        {d.cached > 0 && ` ${mbText(d.cached)} were already there.`}
      </p>
    </div>
  );
}

const mbText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);
