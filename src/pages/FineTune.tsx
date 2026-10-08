import { Info, Lock } from "lucide-react";
import { useState } from "react";
import { Badge, Button, FormRow, Input, PageHeader, Section, Segmented, Select } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { shortModel } from "../lib/format";

type Method = "optimize" | "calibrate" | "train";

// What each method changes, what it needs, and whether it can run on Ollaya models today.
const METHODS: Record<Method, { title: string; what: string; data: string; status: string; changesAccuracy: boolean }> = {
  optimize: {
    title: "Optimize wording",
    what: "Tries variants of the instructions and label descriptions against your ground truth and keeps the best. Works with every model, no training.",
    data: "50–500 labelled rows",
    status: "Planned next — uses only the existing decide API.",
    changesAccuracy: true,
  },
  calibrate: {
    title: "Calibrate",
    what: "Fits temperatures so a 0.8 confidence is right ~80% of the time. Makes confidence thresholds trustworthy; does not change which label wins.",
    data: "100–500 labelled rows, CPU, seconds",
    status: "Supported by Ollaya today via /api/create (calibration temperatures).",
    changesAccuracy: false,
  },
  train: {
    title: "Train (LoRA / head)",
    what: "Teaches the model your labels and vocabulary. Needs a PyTorch trainer and an export back into the engine.",
    data: "300–2,000 labelled rows, GPU or Apple silicon",
    status: "Research — needs a PyTorch sidecar; Ollaya cannot load new weights through its API.",
    changesAccuracy: true,
  },
};

const LOSS = Array.from({ length: 40 }, (_, i) => 1.4 * Math.exp(-i / 9) + 0.18 + 0.04 * Math.sin(i * 1.7));
const VAL = Array.from({ length: 40 }, (_, i) => 1.45 * Math.exp(-i / 10) + 0.24 + 0.05 * Math.cos(i * 1.3));

export function FineTune() {
  const { models } = useApp();
  const datasets = useAsync(() => api.datasets(), []);
  const [method, setMethod] = useState<Method>("calibrate");
  const [model, setModel] = useState("");
  const [dataset, setDataset] = useState("");
  const [split, setSplit] = useState("20%");
  const m = METHODS[method];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Fine-tune <Badge tone="warn">Preview</Badge>
          </span>
        }
        subtitle="Adapt models to your labels using the ground truth you already have."
      />

      <div className="mb-7 flex items-start gap-2.5 rounded-[12px] bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
        <Info className="mt-px size-4 shrink-0" />
        This screen is a design preview — nothing here runs yet.
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-12">
        <div>
          <Section title="Method">
            <Segmented
              value={method}
              onChange={setMethod}
              options={(Object.keys(METHODS) as Method[]).map((k) => ({ value: k, label: METHODS[k].title }))}
            />
            <p className="mt-3 text-[13px] leading-relaxed">{m.what}</p>
            <dl className="mt-3 space-y-1 text-[12.5px]">
              <div className="flex gap-2">
                <dt className="w-20 text-muted-foreground">Needs</dt>
                <dd>{m.data}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 text-muted-foreground">Status</dt>
                <dd>{m.status}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Setup">
            <FormRow label="Base model:" labelWidth={120}>
              <Select value={model || models[0]?.name || ""} onChange={setModel} options={models.map((x) => ({ value: x.name, label: shortModel(x.name) }))} />
            </FormRow>
            <FormRow label="Labelled data:" labelWidth={120}>
              <Select value={dataset || datasets.data?.[0]?.id || ""} onChange={setDataset} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
            </FormRow>
            <FormRow label="Held out:" labelWidth={120} hint="Evaluated before and after, as a regular experiment.">
              <Input className="max-w-[6rem]" value={split} onChange={setSplit} />
            </FormRow>
            <FormRow label="" labelWidth={120}>
              <Button variant="primary" disabled icon={<Lock className="size-3.5" />}>
                Start — coming soon
              </Button>
            </FormRow>
          </Section>
        </div>

        <div className="opacity-80">
          <Section title="What you'll see" subtitle="Illustrative only">
            {method === "train" ? (
              <>
                <LossChart />
                <div className="mt-2 flex gap-4 text-[11.5px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded bg-primary" /> train loss
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded bg-cyan-500" /> validation loss
                  </span>
                </div>
              </>
            ) : (
              <div className="text-[12.5px] text-muted-foreground">{method === "optimize" ? "A table of wording variants with their macro F1 on the held-out rows, best first." : "A reliability diagram before and after, with the fitted temperature per question type."}</div>
            )}
            <div className="mt-5 grid grid-cols-3 gap-6 border-t border-border pt-4">
              {[
                ["Macro F1", m.changesAccuracy ? "0.71 → 0.84" : "unchanged"],
                ["Accuracy", m.changesAccuracy ? "74% → 86%" : "unchanged"],
                ["ECE", method === "optimize" ? "≈" : "0.094 → 0.021"],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-[11px] text-faint">{k}</div>
                  <div className="mt-0.5 font-mono text-[13px] tnum">{v}</div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

function LossChart() {
  const w = 520,
    h = 150,
    max = 1.7;
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${(i / (d.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-36 w-full">
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={0} x2={w} y1={h * t} y2={h * t} stroke="var(--border)" />
      ))}
      <path d={path(VAL)} fill="none" stroke="#06b6d4" strokeWidth={2} />
      <path d={path(LOSS)} fill="none" stroke="var(--primary)" strokeWidth={2} />
    </svg>
  );
}
