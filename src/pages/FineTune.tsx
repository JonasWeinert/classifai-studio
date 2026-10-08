import { Info, Lock, Wand2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Label, PageHeader, Segmented, Select } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { shortModel } from "../lib/format";

// Illustrative curve for the mockup only — not real training output.
const LOSS = Array.from({ length: 40 }, (_, i) => 1.4 * Math.exp(-i / 9) + 0.18 + 0.04 * Math.sin(i * 1.7));
const VAL = Array.from({ length: 40 }, (_, i) => 1.45 * Math.exp(-i / 10) + 0.24 + 0.05 * Math.cos(i * 1.3));

export function FineTune() {
  const { models } = useApp();
  const datasets = useAsync(() => api.datasets(), []);
  const [method, setMethod] = useState<"calibrate" | "lora" | "head">("calibrate");

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Fine-tune <Badge tone="warn">Preview · not functional yet</Badge>
          </span>
        }
        subtitle="Adapt a decision model to your labels using the ground truth you already have."
      />

      <div className="mb-5 flex items-start gap-3 rounded-xl border border-warn/25 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div>
          This screen is a design mockup. Nothing here trains a model yet. The plan (see <span className="font-mono">docs/PRD.md</span>): start with temperature calibration on your labels — Ollaya's <span className="font-mono">/api/create</span> already accepts per-model temperatures — then LoRA / head fine-tuning through a training sidecar, exported back into Ollaya as a new model.
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-5">
        <Card className="p-5">
          <div className="space-y-4">
            <div>
              <Label>Method</Label>
              <Segmented
                value={method}
                onChange={setMethod}
                options={[
                  { value: "calibrate", label: "Calibrate" },
                  { value: "head", label: "Train head" },
                  { value: "lora", label: "LoRA" },
                ]}
              />
              <div className="mt-1.5 text-[11.5px] text-faint">
                {method === "calibrate" && "Fit temperatures so confidences match your data. Minutes on CPU; no weights change."}
                {method === "head" && "Train only the decision head on top of a frozen encoder. Needs a few hundred labelled rows."}
                {method === "lora" && "Low-rank adapters on the backbone. Best accuracy; GPU strongly recommended."}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Base model</Label>
                <Select className="w-full" value={models[0]?.name ?? ""} onChange={() => {}} options={models.map((m) => ({ value: m.name, label: shortModel(m.name) }))} />
              </div>
              <div>
                <Label>Training data</Label>
                <Select className="w-full" value={datasets.data?.[0]?.id ?? ""} onChange={() => {}} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Validation split</Label>
                <Input defaultValue="20%" />
              </div>
              <div>
                <Label>Epochs</Label>
                <Input defaultValue="3" disabled={method === "calibrate"} />
              </div>
              <div>
                <Label>Learning rate</Label>
                <Input defaultValue="2e-4" disabled={method === "calibrate"} />
              </div>
            </div>
            <div>
              <Label>Output model name</Label>
              <Input defaultValue={`${shortModel(models[0]?.name ?? "laya")}-${datasets.data?.[0]?.name ?? "custom"}`} />
            </div>
            <Button variant="primary" size="lg" className="w-full" disabled icon={<Lock className="size-3.5" />}>
              Start training — coming soon
            </Button>
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Training progress" subtitle="Example of what you'll see" actions={<Badge>epoch 3 / 3</Badge>} />
            <div className="px-5 pb-5">
              <LossChart />
              <div className="mt-3 flex gap-4 text-[11.5px] text-muted">
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-accent" /> train loss</span>
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-cyan-500" /> validation loss</span>
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title="Before → after" subtitle="Evaluated on the held-out split, automatically added as an experiment" />
            <div className="grid grid-cols-3 gap-4 px-5 pb-5 opacity-70">
              {[
                ["Macro F1", "0.712", "0.861"],
                ["Accuracy", "74.0%", "87.5%"],
                ["ECE", "0.094", "0.021"],
              ].map(([k, a, b]) => (
                <div key={k} className="rounded-lg bg-panel-2 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-faint">{k}</div>
                  <div className="mt-1 font-mono text-[13px] tnum">
                    <span className="text-muted line-through">{a}</span> <span className="font-semibold text-good">{b}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <div className="flex items-center gap-2 text-[12px] text-faint">
            <Wand2 className="size-3.5" /> Numbers above are placeholders.
          </div>
        </div>
      </div>
    </>
  );
}

function LossChart() {
  const w = 520, h = 160, max = 1.7;
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${(i / (d.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full opacity-80">
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={0} x2={w} y1={h * t} y2={h * t} stroke="var(--line)" />
      ))}
      <path d={path(VAL)} fill="none" stroke="#06b6d4" strokeWidth={2} />
      <path d={path(LOSS)} fill="none" stroke="var(--accent)" strokeWidth={2} />
    </svg>
  );
}
