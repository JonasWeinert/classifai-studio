// The fine-tune parts of the setup form (used by NewExperiment in fine-tune mode): base model,
// hold-out and training options, and the plan with what happens when it starts.
import { BookOpen, Check, Clock, FlaskConical, GraduationCap, HardDrive, Info, Shuffle, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useApp } from "../lib/app";
import { shortModel } from "../lib/format";
import type { FineTuneBase, FineTunePreview, FineTuneSettings } from "../lib/types";
import { cn } from "../lib/utils";
import { duration, estimateSeconds } from "./FineTunePieces";
import { Badge, Button, Card, Disclosure, FormRow, Input, Section, Segmented, Spinner } from "./ui";

export type Effort = "quick" | "standard" | "thorough";
export const EFFORT: Record<Effort, { epochs: number; label: string; hint: string }> = {
  quick: { epochs: 1, label: "Quick", hint: "One pass over the training rows: a first result fast." },
  standard: { epochs: 2, label: "Standard", hint: "Two passes. A good default." },
  thorough: { epochs: 3, label: "Thorough", hint: "Three passes; worth it with few rows or a new head." },
};
const HOLDOUT = [
  { value: "0.1", label: "10%" },
  { value: "0.2", label: "20%" },
  { value: "0.3", label: "30%" },
];

/** Base model and training choices, with defaults. */
export function useFineTuneSetup() {
  const [baseId, setBaseId] = useState("laya-en");
  const [effort, setEffort] = useState<Effort>("standard");
  const [holdout, setHoldout] = useState("0.2");
  const [lr, setLr] = useState("");
  const [rank, setRank] = useState("16");
  const [maxLen, setMaxLen] = useState("");
  const [seed, setSeed] = useState("7");
  const settings = (base: FineTuneBase): FineTuneSettings => ({
    epochs: EFFORT[effort].epochs,
    learning_rate: Number(lr) || base.learning_rate,
    lora_rank: Number(rank) || 16,
    holdout: Number(holdout),
    max_length: Number(maxLen) || base.max_length,
    seed: Number(seed) || 7,
  });
  return { baseId, setBaseId, effort, setEffort, holdout, setHoldout, lr, setLr, rank, setRank, maxLen, setMaxLen, seed, setSeed, settings, epochs: EFFORT[effort].epochs };
}
export type FineTuneSetupState = ReturnType<typeof useFineTuneSetup>;

/** Rough size of the exported model (8-bit weights). */
function modelGb(b: FineTuneBase): number {
  const m = b.params.match(/([\d.]+)\s*([MB])/);
  if (!m) return 1;
  return (parseFloat(m[1]) * (m[2] === "B" ? 1e9 : 1e6) * 1.07) / 1e9;
}

export const fitsMemory = (b: FineTuneBase, memory: number) => memory === 0 || memory + 0.5 >= b.min_memory_gb;

export function BasePicker({ bases, value, onChange, records, epochs, memory }: { bases: FineTuneBase[]; value: string; onChange: (id: string) => void; records: number; epochs: number; memory: number }) {
  const { models } = useApp();
  const installed = (n: string | null) => !!n && models.some((m) => m.name === n || m.name === `${n}:latest`);
  return (
    <Section title="Base model" subtitle="What the fine-tune starts from. Encoders train in minutes; language models read longer text but take longer.">
      <div className="space-y-2">
        {bases.map((b) => {
          const ok = fitsMemory(b, memory);
          const est = records ? estimateSeconds(b, records, epochs) : null;
          return (
            <button
              key={b.id}
              type="button"
              disabled={!ok}
              onClick={() => onChange(b.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-[12px] border px-4 py-3 text-left transition-colors",
                value === b.id ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-sel/50",
                !ok && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
            >
              <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", value === b.id ? "border-primary bg-primary text-white" : "border-border-strong")}>
                {value === b.id && <Check className="size-2.5" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{b.title}</span>
                  <Badge>{b.params}</Badge>
                  <Badge>{b.kind === "encoder" ? "Encoder" : "Language model"}</Badge>
                  {b.recommended && <Badge tone="accent">Recommended</Badge>}
                  {b.new_head && <Badge tone="warn">New head</Badge>}
                </span>
                <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">{b.description}</span>
                <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
                  {est != null && (
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" /> ≈ {duration(est)}
                      {!b.measured && " (rough)"}
                    </span>
                  )}
                  <span>reads ≈ {b.max_length.toLocaleString()} tokens</span>
                  {!ok ? <span className="text-warn">needs {b.min_memory_gb} GB memory</span> : b.min_memory_gb > 8 && <span>needs {b.min_memory_gb} GB memory</span>}
                  {b.ollaya && <span>{installed(b.ollaya) ? `${b.ollaya} is installed — compare against it` : `same model as Ollaya's ${b.ollaya}`}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

export function TrainingOptions({ s, base, name, onName, defaultName }: { s: FineTuneSetupState; base: FineTuneBase | null; name: string; onName: (v: string) => void; defaultName: string }) {
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "model";
  return (
    <Section title="Hold-out and training">
      <FormRow label="Hold out:" hint="Rows set aside before anything else happens. The comparison models answer them first, the fine-tune after training: a fair before and after.">
        <Segmented value={s.holdout} onChange={s.setHoldout} options={HOLDOUT} />
      </FormRow>
      <FormRow label="Effort:" hint={EFFORT[s.effort].hint}>
        <Segmented value={s.effort} onChange={s.setEffort} options={(Object.keys(EFFORT) as Effort[]).map((k) => ({ value: k, label: EFFORT[k].label }))} />
      </FormRow>
      <FormRow label="Name:" hint={name.trim() || defaultName ? <span className="font-mono">ft:{slug(name.trim() || defaultName)}</span> : undefined}>
        <Input className="max-w-sm" value={name} onChange={onName} placeholder={defaultName} />
      </FormRow>
      <div className="mt-2 pl-[162px]">
        <Disclosure label="Advanced">
          <FormRow label="Learning rate:" labelWidth={110} hint="How big each nudge is. Too high and training becomes unstable; too low and it learns slowly.">
            <Input className="max-w-[8rem] font-mono" value={s.lr} onChange={s.setLr} placeholder={base ? String(base.learning_rate) : ""} />
          </FormRow>
          <FormRow label="LoRA rank:" labelWidth={110} hint="Size of the trained adapters. Higher learns more and risks over-fitting small data.">
            <Segmented value={s.rank} onChange={s.setRank} options={["8", "16", "32", "64"].map((v) => ({ value: v, label: v }))} />
          </FormRow>
          <FormRow label="Max input:" labelWidth={110} hint="Tokens read per entry; longer inputs are cut. More is slower.">
            <Input className="max-w-[8rem] font-mono" value={s.maxLen} onChange={s.setMaxLen} placeholder={base ? String(base.max_length) : ""} />
          </FormRow>
          <FormRow label="Seed:" labelWidth={110} hint="Fixes the split and training order, for reproducible runs.">
            <Input className="max-w-[8rem] font-mono" value={s.seed} onChange={s.setSeed} />
          </FormRow>
        </Disclosure>
      </div>
    </Section>
  );
}

/** The plan: split, time, what happens in which order, problems, and the start button. */
export function PlanCard({
  preview,
  base,
  epochs,
  compare,
  errors,
  canStart,
  starting,
  onStart,
  pending,
}: {
  preview: FineTunePreview | null;
  base: FineTuneBase | null;
  epochs: number;
  compare: string[];
  errors: string[];
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  /** Why there is no plan yet (setup incomplete). */
  pending?: string[];
}) {
  const { go } = useApp();
  const seconds = base && preview?.split.records ? estimateSeconds(base, preview.split.records, epochs) : null;
  const steps = preview
    ? [
        { icon: <Shuffle />, text: `Set aside ${preview.split.test.toLocaleString()} rows for the final test` },
        compare.length
          ? { icon: <FlaskConical />, text: `${compare.map(shortModel).join(", ")} answer${compare.length === 1 ? "s" : ""} them: the bar to beat` }
          : { icon: <FlaskConical />, text: "No comparison models: only the fine-tune is tested", muted: true },
        { icon: <GraduationCap />, text: `Train ${base?.title ?? "the base"} on ${preview.split.train.toLocaleString()} rows, calibrate on ${preview.split.calibration.toLocaleString()}` },
        { icon: <Sparkles />, text: "The fine-tune answers the held-out rows; results side by side" },
      ]
    : [];
  return (
    <Card className="px-5 py-4">
      <div className="text-[13px] font-semibold">Plan</div>
      {!preview ? (
        pending?.length ? (
          <ul className="mt-2 space-y-1 text-[12px] text-muted-foreground">
            {pending.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        ) : (
          <div className="py-6">
            <Spinner />
          </div>
        )
      ) : (
        <>
          <SplitBar train={preview.split.train} calib={preview.split.calibration} test={preview.split.test} />
          <ol className="mt-4 space-y-2.5">
            {steps.map((s, i) => (
              <li key={i} className={cn("flex gap-2.5 text-[12px] leading-snug", "muted" in s && s.muted && "text-faint")}>
                <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary [&_svg]:size-3">{s.icon}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
          <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-[12px]">
            {seconds != null && (
              <div className="flex items-start gap-2">
                <Clock className="mt-px size-3.5 text-faint" />
                <span>
                  Training ≈ {duration(seconds)}
                  <span className="block text-[11px] text-faint">{base?.measured ? "Measured on an M2 Max; yours may differ." : "Rough estimate; not measured yet."}</span>
                </span>
              </div>
            )}
            {base && (
              <div className="flex items-start gap-2">
                <HardDrive className="mt-px size-3.5 text-faint" />
                <span>
                  ≈ {modelGb(base) < 1 ? `${Math.round(modelGb(base) * 1000)} MB` : `${modelGb(base).toFixed(1)} GB`} for the model
                  <span className="block text-[11px] text-faint">The base model downloads once from Hugging Face.</span>
                </span>
              </div>
            )}
          </dl>
          {(errors.length > 0 || preview.warnings.length > 0) && (
            <div className="mt-3 space-y-2 border-t border-border pt-3 text-[12px]">
              {errors.map((w) => (
                <div key={w} className="flex gap-2 text-bad">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {w}
                </div>
              ))}
              {preview.warnings.map((w) => (
                <div key={w} className="flex gap-2 text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0 text-warn" />
                  {w}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <Button variant="primary" className="mt-5 w-full justify-center" disabled={!canStart} loading={starting} icon={<Sparkles className="size-3.5" />} onClick={onStart}>
        Start fine-tune
      </Button>
      <div className="mt-2 text-center text-[11px] text-faint">You can keep using the app while it runs.</div>
      <button onClick={() => go({ page: "docs", topic: "finetuning" })} className="mx-auto mt-3 flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
        <BookOpen className="size-3" /> How fine-tuning works
      </button>
    </Card>
  );
}

function SplitBar({ train, calib, test }: { train: number; calib: number; test: number }) {
  const total = Math.max(1, train + calib + test);
  const parts = [
    { n: train, label: "train", color: "var(--primary)" },
    { n: calib, label: "calibrate", color: "#06b6d4" },
    { n: test, label: "test", color: "#f59e0b" },
  ];
  return (
    <div className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-sel">
        {parts.map((p) => (
          <div key={p.label} className="transition-[width] duration-500" style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11.5px]">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            <span className="font-medium tnum">{p.n.toLocaleString()}</span>
            <span className="text-faint">{p.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
