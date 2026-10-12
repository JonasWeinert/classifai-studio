// One fine-tune: live progress while it trains, then the held-out test against the models it
// should beat, how training went, and the settings it ran with.
import { ArrowUpRight, FolderOpen, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { duration, FineTuneBadge, isActive, overallProgress } from "../components/FineTunePieces";
import { DownloadPanel, LiveStats, LossCurve, LossTrendNote, StagePipeline, WeightsWaffle, WhatItLearned } from "../components/FineTuneViz";
import { Badge, Button, Card, CardHeader, Disclosure, ErrorNote, PageHeader, Progress, Section, Spinner, Stat, Tooltip } from "../components/ui";
import { api, events, openExternal } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago, bytes, modelColor, ms, num, pct, shortModel } from "../lib/format";
import { cn } from "../lib/utils";
import type { FineTune, Report } from "../lib/types";
import { DeleteFineTune, reveal, useTryInPlayground } from "./FineTune";

export function FineTuneRun({ id }: { id: string }) {
  const { go, toast } = useApp();
  const tryInPlayground = useTryInPlayground();
  const loaded = useAsync(() => api.fineTune(id), [id]);
  const [live, setLive] = useState<FineTune | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setLive(null);
    const un = events.fineTune((f) => f.id === id && setLive(f));
    return () => void un.then((u) => u());
  }, [id]);
  const f = live ?? loaded.data;
  const bases = useAsync(() => api.fineTuneBases(), []);
  const base = bases.data?.find((b) => b.id === f?.base);

  if (loaded.error)
    return (
      <>
        <PageHeader title="Fine-tune" back={{ label: "Fine-tune", onClick: () => go({ page: "finetune" }) }} />
        <ErrorNote>{loaded.error}</ErrorNote>
      </>
    );
  if (!f) return <Spinner />;
  const active = isActive(f.status);

  return (
    <>
      <PageHeader
        back={{ label: "Fine-tune", onClick: () => go({ page: "finetune" }) }}
        title={
          <span className="flex items-center gap-3">
            {f.name} <FineTuneBadge status={f.status} />
          </span>
        }
        subtitle={
          <span>
            <span className="font-mono">{f.model}</span> · {f.base_title} · learned from{" "}
            <button className="hover:text-foreground hover:underline" onClick={() => go({ page: "dataset", id: f.dataset_id })}>
              {f.dataset_name}
            </button>
            {f.experiment_id && f.experiment_name && (
              <>
                {" "}
                (set up from{" "}
                <button className="hover:text-foreground hover:underline" onClick={() => go({ page: "experiment", id: f.experiment_id! })}>
                  {f.experiment_name}
                </button>
                )
              </>
            )}{" "}
            · {ago(f.created_at)}
          </span>
        }
        actions={
          <>
            {active && (
              <Button icon={<Square className="size-3" />} onClick={() => api.fineTuneCancel(f.id)}>
                Stop
              </Button>
            )}
            {f.status === "ready" && (
              <Button variant="primary" icon={<Play className="size-3.5" />} onClick={() => tryInPlayground(f)}>
                Try in Playground
              </Button>
            )}
            <Tooltip content="Training data, log and result files" side="bottom">
              <Button variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={async () => reveal(await api.fineTuneFolder(f.id))}>
                Files
              </Button>
            </Tooltip>
            {!active && (
              <Tooltip content="Delete the model and its training files" side="bottom">
                <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(true)} />
              </Tooltip>
            )}
          </>
        }
      />

      {f.status !== "ready" && (
        <Card className="mb-8 px-6 pt-5 pb-5">
          <StagePipeline f={f} />
        </Card>
      )}

      {f.status === "failed" && <ErrorNote>{f.error ?? "The fine-tune failed."}</ErrorNote>}
      {f.status === "ready" && f.error && <ErrorNote>{f.error}</ErrorNote>}
      {f.status === "cancelled" && <div className="mb-6 text-[12.5px] text-muted-foreground">Stopped before it finished. Nothing was installed.</div>}

      {active && (f.status === "training" || f.status === "evaluating") && (
        <Section
          title="Training"
          subtitle={
            f.status === "training" && f.progress.stage === "training" && f.progress.total_steps
              ? `Step ${f.progress.step} of ${f.progress.total_steps} · pass ${Math.min(Math.floor(f.progress.epoch) + 1, Math.ceil(f.settings.epochs))} of ${f.settings.epochs}`
              : undefined
          }
        >
          <Progress value={overallProgress(f)} indeterminate={f.status === "training" && f.progress.stage === "loading" && !(f.progress.download?.total)} />
          {f.status === "training" && f.progress.stage === "loading" ? (
            <Card className="mt-4 px-5 py-4">
              <DownloadPanel f={f} />
            </Card>
          ) : (
            <div className="mt-4">
              <LiveStats f={f} />
            </div>
          )}
          <div className={cn("mt-5", f.status === "training" && f.progress.stage === "loading" && "hidden")}>
            <LossCurve loss={f.progress.loss} total={f.progress.total_steps} epochs={f.settings.epochs} live={f.progress.stage === "training"} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <LossTrendNote loss={f.progress.loss} />
              <span className="text-[11px] text-faint">Loss: how surprised the model is by your labels. Lower is better; dots are single steps, the line is smoothed.</span>
            </div>
          </div>
          {f.parameters != null && f.trainable_parameters != null && (
            <div className="mt-6">
              <WeightsWaffle total={f.parameters} trainable={f.trainable_parameters} />
            </div>
          )}
          {f.before && (
            <div className="mt-5 text-[12px] text-muted-foreground">
              Starting point: <span className="font-mono tnum">{pct(f.before.accuracy, 1)}</span> right on the calibration rows
              {f.after && (
                <>
                  , now <span className="font-mono font-semibold text-good tnum">{pct(f.after.accuracy, 1)}</span>
                </>
              )}
              .
            </div>
          )}
        </Section>
      )}

      {f.eval_experiment_id && f.status !== "queued" && f.status !== "preparing" && f.status !== "cancelled" && <HeldOut f={f} />}

      {f.has_analysis && f.after && <Learned id={f.id} f={f} />}

      {!active && f.status !== "cancelled" && (f.progress.loss.length > 0 || f.before) && (
        <Section title="How training went" subtitle={f.train_seconds != null ? `${duration(f.train_seconds)} on this Mac` : undefined}>
          <div className="grid grid-cols-[minmax(0,1fr)_17rem] gap-10">
            <div>
              <LossCurve loss={f.progress.loss} total={f.progress.total_steps} epochs={f.settings.epochs} height={170} />
              <div className="mt-2">
                <LossTrendNote loss={f.progress.loss} />
              </div>
            </div>
            <div className="space-y-5">
              {f.before && f.after && (
                <Stat label="Calibration error (ECE)" value={`${num(f.before.ece, 3)} → ${num(f.after.ece, 3)}`} tone={f.after.ece < f.before.ece ? "good" : undefined} sub="Lower: its confidence matches how often it's right." />
              )}
              {f.parameters != null && f.trainable_parameters != null && <WeightsWaffle total={f.parameters} trainable={f.trainable_parameters} stacked />}
            </div>
          </div>
        </Section>
      )}

      <Section title="Setup">
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-3 text-[12.5px]">
          <Item label="Base">{f.base_title}</Item>
          <Item label="Questions">{f.questions.join(", ")}</Item>
          {f.split && (
            <>
              <Item label="Labelled rows">{f.split.labelled.toLocaleString()}</Item>
              <Item label="Train / calibrate / test">
                {f.split.train.toLocaleString()} / {f.split.calibration.toLocaleString()} / {f.split.test.toLocaleString()}
              </Item>
            </>
          )}
          <Item label="Passes">{f.settings.epochs}</Item>
          <Item label="Learning rate">
            <span className="font-mono">{f.settings.learning_rate}</span>
          </Item>
          <Item label="LoRA rank">{f.settings.lora_rank}</Item>
          <Item label="Max input">{f.settings.max_length.toLocaleString()} tokens</Item>
          <Item label="Seed">{f.settings.seed}</Item>
          {f.size_bytes > 0 && <Item label="Model file">{bytes(f.size_bytes)} (GGUF, 8-bit)</Item>}
          {base && (
            <Item label="Licence">
              <Tooltip content={`Its weights derive from ${base.title}. If you share the model, include NOTICE.txt from its folder.`}>
                <button className="inline-flex items-center gap-1 hover:text-primary hover:underline" onClick={() => openExternal(`https://huggingface.co/${base.repo}`)}>
                  {base.license} <span className="text-faint">via {base.title}</span>
                </button>
              </Tooltip>
            </Item>
          )}
        </dl>
        {f.test_dataset_id && (
          <button className="mt-4 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => go({ page: "dataset", id: f.test_dataset_id! })}>
            Held-out rows as a dataset <ArrowUpRight className="size-3" />
          </button>
        )}
      </Section>

      <Section title="Trainer output">
        <TrainerLog id={f.id} active={active} />
      </Section>

      <DeleteFineTune
        job={deleting ? f : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          toast(`Deleted ${f.name}`);
          go({ page: "finetune" });
        }}
      />
    </>
  );
}

/** What changed on the calibration rows: overall, per label, confidence, and example rows. */
function Learned({ id, f }: { id: string; f: FineTune }) {
  const analysis = useAsync(() => api.fineTuneAnalysis(id), [id, f.status]);
  const rows = analysis.data?.rows ?? [];
  if (!rows.some((r) => r.after != null)) return null;
  const n = new Set(rows.map((r) => r.row)).size;
  return (
    <Section title="What it learned" subtitle={`${n.toLocaleString()} calibration rows, answered before and after training. ${f.base_title} never trained on them.`}>
      <WhatItLearned rows={rows} />
    </Section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

/** The held-out test: the fine-tune against the models it is meant to beat, per question. */
function HeldOut({ f }: { f: FineTune }) {
  const { go } = useApp();
  const evalId = f.eval_experiment_id!;
  const exp = useAsync(() => api.experiment(evalId), [evalId, f.status]);
  const reports = useAsync(() => Promise.all(f.questions.map((q) => api.report(evalId, q).catch(() => null))), [evalId, f.status]);
  // Follow the test while it runs.
  useEffect(() => {
    if (f.status !== "evaluating" && f.status !== "baseline") return;
    const un = events.progress((e) => {
      if (e.experiment_id === evalId && (e.status !== "running" || e.done % 20 === 0)) reports.reload();
    });
    return () => void un.then((u) => u());
  }, [evalId, f.status, reports]);

  const list = (reports.data ?? []).filter(Boolean) as Report[];
  const total = exp.data?.row_indices.length ?? f.split?.test ?? 0;
  const running = f.status === "evaluating" || f.status === "baseline" || exp.data?.status === "running";
  const before = f.status === "baseline" || f.status === "training";

  return (
    <Section
      title={before ? "The bar to beat" : "Held-out test"}
      subtitle={
        before
          ? `How the comparison models do on the ${total.toLocaleString()} held-out rows. The fine-tune answers the same rows once it's trained.`
          : `${total.toLocaleString()} labelled rows the fine-tune never saw, answered by it and the models it's compared against.`
      }
      actions={
        <Button size="sm" variant="ghost" icon={<ArrowUpRight className="size-3" />} onClick={() => go({ page: "experiment", id: evalId })}>
          Open evaluation
        </Button>
      }
    >
      {running && (
        <div className="mb-4 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Spinner delay={0} /> Testing…
        </div>
      )}
      {list.map((r) => (
        <QuestionResult key={r.question_id} r={r} model={f.model} multi={list.length > 1} />
      ))}
    </Section>
  );
}

function QuestionResult({ r, model, multi }: { r: Report; model: string; multi: boolean }) {
  const mine = r.models.find((m) => m.model === model);
  const others = r.models.filter((m) => m.model !== model && m.evaluated > m.errors);
  const best = [...others].sort((a, b) => b.macro_f1 - a.macro_f1)[0];
  const rows = [...r.models].sort((a, b) => (a.model === model ? -1 : b.model === model ? 1 : b.macro_f1 - a.macro_f1));
  const delta = mine && best ? mine.accuracy - best.accuracy : null;
  return (
    <div className="mb-6">
      {multi && <div className="mb-2 font-mono text-[12px] text-muted-foreground">{r.question_id}</div>}
      {mine && (
        <div className="mb-4 grid grid-cols-4 gap-6">
          <Stat
            label="Accuracy"
            value={pct(mine.accuracy, 1)}
            tone={delta != null && delta > 0 ? "good" : undefined}
            sub={best && delta != null ? <span className={delta < 0 ? "text-bad" : undefined}>{`${delta >= 0 ? "+" : "−"}${(Math.abs(delta) * 100).toFixed(1)} pts vs ${shortModel(best.model)}`}</span> : undefined}
          />
          <Stat label="Macro F1" value={num(mine.macro_f1, 3)} sub={best ? `${shortModel(best.model)}: ${num(best.macro_f1, 3)}` : undefined} />
          <Stat label="Calibration error" value={num(mine.ece, 3)} sub={best ? `${shortModel(best.model)}: ${num(best.ece, 3)}` : undefined} />
          <Stat label="Latency (median)" value={ms(mine.latency_p50_ms)} sub={best ? `${shortModel(best.model)}: ${ms(best.latency_p50_ms)}` : undefined} />
        </div>
      )}
      <Card>
        <CardHeader title="All models on the held-out rows" />
        <table className="w-full text-[12.5px]">
          <thead className="text-[11px] text-faint">
            <tr className="border-t border-border">
              <th className="px-4 py-2 text-left font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Accuracy</th>
              <th className="px-3 py-2 text-right font-medium">Macro F1</th>
              <th className="px-3 py-2 text-right font-medium">κ</th>
              <th className="px-3 py-2 text-right font-medium">ECE</th>
              <th className="px-3 py-2 text-right font-medium">Errors</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.model} className={cn("border-t border-border", m.model === model && "bg-primary/[0.05]")}>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full" style={{ background: modelColor(i) }} />
                    <span className={m.model === model ? "font-medium" : ""}>{shortModel(m.model)}</span>
                    {m.model === model && <Badge tone="accent">fine-tuned</Badge>}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tnum">{pct(m.accuracy, 1)}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{num(m.macro_f1, 3)}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{num(m.kappa, 3)}</td>
                <td className="px-3 py-2 text-right font-mono tnum">{num(m.ece, 3)}</td>
                <td className={cn("px-3 py-2 text-right font-mono tnum", m.errors > 0 && "text-bad")}>{m.errors}</td>
                <td className="px-4 py-2 text-right font-mono tnum text-muted-foreground">{ms(m.latency_p50_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function TrainerLog({ id, active }: { id: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => api.fineTuneLog(id).then((t) => live && setText(t));
    load();
    const t = active ? setInterval(load, 3000) : undefined;
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id, open, active]);
  return (
    <div onClick={() => setOpen(true)}>
      <Disclosure label="Show the last lines of the trainer's output">
        <pre className="max-h-72 overflow-auto rounded-[10px] bg-card px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-muted-foreground">{text || "Nothing yet."}</pre>
      </Disclosure>
    </div>
  );
}
