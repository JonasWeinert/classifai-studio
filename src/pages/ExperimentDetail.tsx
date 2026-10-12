import clsx from "clsx";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Copy, GitCompareArrows, ListChecks, Pencil, Play, SlidersHorizontal, Square, SquareArrowOutUpRight, Trash2, Trophy, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfusionMatrix, heat, MetricBars, Reliability } from "../components/charts";
import { ThresholdPanel } from "../components/ThresholdPanel";
import { Badge, Button, CardHeader, ErrorNote, Input, Modal, PageHeader, Progress, Segmented, Select, Spinner, Tooltip } from "../components/ui";
import { api, errorMessage, events, pickSavePath } from "../lib/api";
import { kappaWord } from "../lib/insights";
import { openSetupInPlayground } from "../lib/setupPlayground";
import { Clamp } from "../components/Clamp";
import { ModelLoading } from "../components/RunPieces";
import { useModelState } from "../lib/modelStatus";
import { useApp } from "../lib/app";
import { ago, modelColor, ms, num, pct, shortModel, usd } from "../lib/format";
import type { ExperimentConfig, Experiment, ExperimentStatus, ModelMetrics, Page, PredictionRow, Report, TaskSpec, UsageRow } from "../lib/types";

const OVERALL = "__overall";

export function StatusBadge({ status }: { status: ExperimentStatus }) {
  const map: Record<ExperimentStatus, [string, "neutral" | "accent" | "good" | "bad" | "warn"]> = {
    pending: ["Pending", "neutral"],
    running: ["Running", "accent"],
    completed: ["Completed", "good"],
    cancelled: ["Stopped", "warn"],
    failed: ["Failed", "bad"],
  };
  const [label, tone] = map[status];
  return (
    <Badge tone={tone}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      {label}
    </Badge>
  );
}

/** Landis & Koch wording for a kappa value. */
export function ExperimentDetail({ id }: { id: string }) {
  const { go, toast } = useApp();
  const [exp, setExp] = useState<Experiment | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [usage, setUsage] = useState<Record<string, UsageRow>>({});
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The model being loaded into memory before its first request, and since when.
  const [warming, setWarming] = useState<{ model: string; since: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [asDataset, setAsDataset] = useState<string | null>(null);
  const [savingDataset, setSavingDataset] = useState(false);
  const [tick, setTick] = useState(0); // bumps when predictions change, to refresh the table
  const [view, setView] = useState<string | null>(null);
  const question = view && view !== OVERALL ? view : undefined;

  const load = useCallback(async () => {
    try {
      const [e, r] = await Promise.all([api.experiment(id), api.report(id, question)]);
      setExp(e);
      setReport(r);
      setView((v) => v ?? (e.config.tasks.length > 1 ? OVERALL : e.config.tasks[0]?.id ?? null));
      api.experimentUsage(id).then((u) => setUsage(Object.fromEntries(u.map((x) => [x.model, x])))).catch(() => {});
      setTick((t) => t + 1);
    } catch (err) {
      setError(err);
    }
  }, [id, question]);

  useEffect(() => {
    load();
  }, [load]);

  // Live progress: patch counts from events, refresh metrics at most every 1.5 s.
  const lastRefresh = useRef(0);
  useEffect(() => {
    const un = events.progress((ev) => {
      if (ev.experiment_id !== id) return;
      if (ev.message !== undefined) setMessage(ev.loading ? null : ev.message);
      setWarming((w) => (ev.loading && ev.model ? (w?.model === ev.model ? w : { model: ev.model, since: Date.now() }) : null));
      setExp((e) => (e ? { ...e, status: ev.status, progress: ev.model ? { ...e.progress, [ev.model]: ev.done } : e.progress } : e));
      const now = Date.now();
      if (ev.status !== "running" || now - lastRefresh.current > 1500) {
        lastRefresh.current = now;
        load();
      }
    });
    return () => void un.then((f) => f());
  }, [id, load]);

  if (error != null && !exp) return <ErrorNote error={error} />;
  if (!exp || !report) return <Spinner />;

  const total = exp.row_indices.length;
  const running = exp.status === "running" || exp.status === "pending";
  const doneAll = Object.values(exp.progress).reduce((a, b) => a + b, 0);
  const color = (m: string) => modelColor(exp.config.models.indexOf(m));
  const scored = report.models.filter((m) => m.evaluated - m.errors > 0);
  const ranked = [...scored].sort((a, b) => b.macro_f1 - a.macro_f1 || b.accuracy - a.accuracy);
  const tasks = exp.config.tasks;
  const task = tasks.find((t) => t.id === report.question_id) ?? tasks[0];
  const overall = view === OVERALL && tasks.length > 1;

  const doExport = async (fmt: string) => {
    if (fmt === "dataset") return setAsDataset(`${exp.name} results`);
    const f = fmt as "csv" | "md" | "html";
    const base = exp.name.replace(/[^\w.-]+/g, "_");
    const filter = f === "csv" ? { name: "CSV", extensions: ["csv"] } : f === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "HTML", extensions: ["html"] };
    const path = await pickSavePath(`${base}${f === "csv" ? "" : "_report"}.${f}`, filter);
    if (!path) return;
    try {
      if (f === "csv") {
        const n = await api.exportCsv(id, path);
        toast(`Exported ${n} rows`, "good");
      } else {
        const out = await api.exportReport(id, path, f);
        toast(`Report saved to ${out || path}`, "good");
      }
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <>
      <PageHeader
        back={{ label: "Evaluations", onClick: () => go({ page: "experiments" }) }}
        title={
          <span className="flex items-center gap-3">
            {exp.name} <StatusBadge status={exp.status} />
          </span>
        }
        subtitle={
          <span>
            <button className="hover:text-foreground hover:underline" onClick={() => go({ page: "dataset", id: exp.dataset_id })}>
              {exp.dataset_name}
            </button>
            {" · "}
            {total.toLocaleString()} rows · {tasks.length} question{tasks.length === 1 ? "" : "s"} · {exp.config.models.length} models · {ago(exp.created_at)}
          </span>
        }
        actions={
          <>
            {running ? (
              <Button icon={<Square className="size-3" />} onClick={() => api.experimentCancel(id)}>
                Stop
              </Button>
            ) : (
              doneAll < total * exp.config.models.length && (
                <Button
                  icon={<Play className="size-3.5" />}
                  onClick={async () => {
                    await api.experimentStart(id);
                    load();
                  }}
                >
                  Resume
                </Button>
              )
            )}
            <Tooltip content="Go through uncertain or disputed rows and fix the ground truth" side="bottom">
              <Button variant="ghost" icon={<ListChecks className="size-3.5" />} disabled={running} onClick={() => go({ page: "review", id, question: overall ? undefined : task.id })}>
                Review…
              </Button>
            </Tooltip>
            <Tooltip content="Compare with another run" side="bottom">
              <Button variant="ghost" icon={<GitCompareArrows className="size-3.5" />} onClick={() => go({ page: "compare", a: id })}>
                Compare…
              </Button>
            </Tooltip>
            <Tooltip content="Train a local model on this setup's labels" side="bottom">
              <Button variant="ghost" icon={<SlidersHorizontal className="size-3.5" />} disabled={running} onClick={() => go({ page: "finetune-new", fromExperiment: id })}>
                Fine-tune…
              </Button>
            </Tooltip>
            <Tooltip content="Open the setup pre-filled, to tweak and re-run" side="bottom">
              <Button variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => go({ page: "new-experiment", fromExperiment: id })}>
                Duplicate…
              </Button>
            </Tooltip>
            <Select
              className="min-w-[7.5rem]"
              value=""
              placeholder="Export…"
              onChange={doExport}
              options={[
                { value: "csv", label: "Predictions (CSV)" },
                { value: "md", label: "Report (Markdown)" },
                { value: "html", label: "Report (HTML)" },
                { value: "dataset", label: "Predictions as a dataset…" },
              ]}
            />
            <Tooltip content="Delete evaluation" side="bottom">
              <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)} />
            </Tooltip>
          </>
        }
      />

      {exp.error && (
        <div className="mb-4">
          <ErrorNote error={exp.error} />
        </div>
      )}

      {running && (
        <div className="mb-7 fade-up">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[13.5px] font-semibold">Running…</div>
            <div className="text-[12px] text-muted-foreground">{message ?? `${doneAll.toLocaleString()} / ${(total * exp.config.models.length).toLocaleString()} decisions`}</div>
          </div>
          <div className="space-y-2.5">
            {exp.config.models.map((m) => (
              <RunningModelRow
                key={m}
                model={m}
                done={exp.progress[m] ?? 0}
                total={total}
                color={color(m)}
                // Models run one after another: the first one not finished is the one working now.
                current={exp.config.models.find((x) => (exp.progress[x] ?? 0) < total) === m}
                warmingSince={warming?.model === m ? warming.since : null}
              />
            ))}
          </div>
        </div>
      )}

      {tasks.length > 1 && (
        <div className="mb-5 flex items-center gap-3">
          <Segmented value={overall ? OVERALL : task.id} onChange={(v) => setView(v)} options={[{ value: OVERALL, label: "Overall" }, ...tasks.map((t) => ({ value: t.id, label: t.label_column }))]} />
        </div>
      )}

      {overall ? (
        <Overall exp={exp} tick={tick} color={color} onPick={setView} />
      ) : (
        <>
          <div className="mb-4 text-[12.5px] text-muted-foreground">
            <span className="font-medium text-foreground">“{task.instructions}”</span> ·{" "}
            {task.kind === "binary" ? `yes/no, positive = ${task.positive_label}${task.threshold != null ? `, threshold ${task.threshold.toFixed(2)}` : ""}` : `${task.labels.length} labels`} · ground truth{" "}
            <span className="font-mono">{task.label_column}</span>
            {(exp.config.context?.trim() || task.context?.trim()) && (
              <Clamp className="mt-1.5 max-w-3xl text-[12px] leading-snug">
                {[exp.config.context?.trim() && `Shared context: ${exp.config.context.trim()}`, task.context?.trim() && `Context: ${task.context.trim()}`].filter(Boolean).join("\n")}
              </Clamp>
            )}
          </div>

          {ranked.length > 0 && <Leaderboard report={report} ranked={ranked} color={color} usage={usage} rows={total} onReview={() => go({ page: "review", id, question: task.id })} />}

          {ranked.length > 0 && (
            <div className="mt-8 grid grid-cols-3 gap-10 border-t border-border pt-6">
              <div>
                <div className="mb-3 text-[12.5px] font-semibold">Accuracy</div>
                <MetricBars items={scored.map((m) => ({ label: shortModel(m.model), value: m.accuracy, color: color(m.model) }))} format={(v) => pct(v)} />
              </div>
              <div>
                <div className="mb-3 text-[12.5px] font-semibold">Macro F1</div>
                <MetricBars items={scored.map((m) => ({ label: shortModel(m.model), value: m.macro_f1, color: color(m.model) }))} format={(v) => num(v)} />
              </div>
              <div>
                <div className="mb-3 text-[12.5px] font-semibold">
                  Median latency <span className="font-normal text-faint">· lower is better</span>
                </div>
                <MetricBars higherIsBetter={false} items={scored.map((m) => ({ label: shortModel(m.model), value: m.latency_p50_ms, color: color(m.model) }))} format={ms} />
              </div>
            </div>
          )}

          {ranked.length > 0 && <ModelDeepDive report={{ ...report, models: scored }} color={color} />}

          {task.kind === "binary" && ranked.length > 0 && !running && (
            <ThresholdPanel
              key={task.id}
              experimentId={id}
              question={task.id}
              positive={task.positive_label ?? "yes"}
              models={ranked.map((m) => m.model)}
              onApplied={() => {
                toast("Threshold applied — metrics recomputed", "good");
                load();
              }}
            />
          )}

          {report.models.length > 1 && ranked.length > 1 && <Agreement report={report} color={color} />}

          <PredictionsExplorer key={task.id} id={id} datasetId={exp.dataset_id} config={exp.config} task={task} models={exp.config.models} color={color} tick={tick} onChanged={load} />
        </>
      )}

      <Modal
        open={asDataset !== null}
        onClose={() => setAsDataset(null)}
        title="Save predictions as a dataset"
        footer={
          <>
            <Button onClick={() => setAsDataset(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={savingDataset}
              disabled={!asDataset?.trim()}
              onClick={async () => {
                setSavingDataset(true);
                try {
                  const d = await api.experimentSaveAsDataset(id, asDataset ?? "");
                  setAsDataset(null);
                  toast(`Saved “${d.name}” · ${d.row_count.toLocaleString()} rows`, "good");
                  go({ page: "dataset", id: d.id });
                } catch (e) {
                  toast(errorMessage(e), "bad");
                } finally {
                  setSavingDataset(false);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div>
          <Input value={asDataset ?? ""} onChange={setAsDataset} autoFocus />
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            The {total.toLocaleString()} evaluated rows link to <b className="font-medium text-foreground">{exp.dataset_name}</b> rather than being copied. Only a prediction and a confidence column per question
            {exp.config.models.length > 1 ? " and model" : ""} are stored.
          </p>
        </div>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete evaluation?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                await api.experimentDelete(id);
                go({ page: "experiments" });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted-foreground">All predictions of “{exp.name}” are removed. The dataset stays.</p>
      </Modal>
    </>
  );
}

// ---- R2: overall view across questions ---------------------------------------------------------

function Overall({ exp, tick, color, onPick }: { exp: Experiment; tick: number; color: (m: string) => string; onPick: (q: string) => void }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const tasks = exp.config.tasks;
  useEffect(() => {
    let live = true;
    Promise.all(tasks.map((t) => api.report(exp.id, t.id)))
      .then((r) => live && setReports(r))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exp.id, tick]);

  const stats = useMemo(() => {
    if (!reports) return null;
    const models = exp.config.models;
    const f1 = (r: Report, m: string) => {
      const x = r.models.find((y) => y.model === m);
      return x && x.evaluated - x.errors > 0 ? x.macro_f1 : null;
    };
    const ranks: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
    reports.forEach((r) => {
      const scored = models.map((m) => [m, f1(r, m)] as const).filter(([, v]) => v !== null) as [string, number][];
      scored.forEach(([m, v]) => ranks[m].push(1 + scored.filter(([, w]) => w > v).length));
    });
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const meanRank = Object.fromEntries(models.map((m) => [m, mean(ranks[m])]));
    const meanF1 = Object.fromEntries(models.map((m) => [m, mean(reports.map((r) => f1(r, m)).filter((v): v is number => v !== null))]));
    const order = [...models].sort((a, b) => (meanRank[a] ?? 99) - (meanRank[b] ?? 99) || (meanF1[b] ?? 0) - (meanF1[a] ?? 0));
    return { f1, meanRank, meanF1, order };
  }, [reports, exp.config.models]);

  if (error != null) return <ErrorNote error={error} />;
  if (!reports || !stats) return <Spinner />;
  const { f1, meanRank, meanF1, order } = stats;
  const best = order[0];
  // Shade relative to the spread in this table, so small differences stay visible.
  const all = reports.flatMap((r) => order.map((m) => f1(r, m))).filter((v): v is number => v !== null);
  const lo = Math.min(...all, 1),
    hi = Math.max(...all, 0);
  const rel = (v: number) => (hi - lo > 1e-6 ? 0.15 + (0.85 * (v - lo)) / (hi - lo) : 0.6);

  return (
    <div className="fade-up">
      {meanRank[best] != null && (
        <div className="mb-3 flex items-center gap-2.5 py-1 text-[13px]">
          <Trophy className="size-4 shrink-0" style={{ color: color(best) }} />
          <span>
            <b>{shortModel(best)}</b> ranks best across {tasks.length} questions <span className="text-muted-foreground">— mean rank {meanRank[best]!.toFixed(1)}, mean macro F1 {num(meanF1[best] ?? 0)}</span>
          </span>
        </div>
      )}
      <div className="overflow-auto">
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-[11.5px] text-faint">
            <tr>
              <th className="py-2 pr-3 text-left font-medium">Question · macro F1</th>
              {order.map((m) => (
                <th key={m} className="px-1 py-2 text-center font-medium">
                  <span className="flex items-center justify-center gap-1.5 text-muted-foreground">
                    <span className="size-1.5 rounded-full" style={{ background: color(m) }} />
                    {shortModel(m)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => {
              const vals = order.map((m) => f1(reports[i], m)).filter((v): v is number => v !== null);
              const top = vals.length ? Math.max(...vals) : null;
              return (
                <tr key={t.id} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    <button onClick={() => onPick(t.id)} className="block w-full max-w-[min(36rem,32vw)] truncate text-left hover:text-primary" title={t.instructions}>
                      <span className="font-medium">{t.label_column}</span> <span className="text-[12px] text-muted-foreground">{t.instructions}</span>
                    </button>
                  </td>
                  {order.map((m) => {
                    const v = f1(reports[i], m);
                    return (
                      <td key={m} className="p-0.5">
                        <div
                          className={clsx("grid h-9 min-w-20 place-items-center rounded-md font-mono text-[12px] tnum", v === top && "font-semibold")}
                          style={{ background: v === null ? "var(--card)" : heat(rel(v)), color: v === null ? "var(--faint)" : rel(v) > 0.7 ? "#fff" : "var(--foreground)" }}
                        >
                          {v === null ? "—" : num(v)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="text-[12.5px]">
            <tr className="border-t border-border-strong/60">
              <td className="py-2 pr-3 text-muted-foreground">Mean macro F1</td>
              {order.map((m) => (
                <td key={m} className="py-2 text-center font-mono tnum">
                  {meanF1[m] == null ? "—" : num(meanF1[m]!)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-1 pr-3 text-muted-foreground">
                <Tooltip content="Average position when models are ranked by macro F1 within each question. 1 = best everywhere.">
                  <span className="cursor-help border-b border-dotted border-faint">Mean rank</span>
                </Tooltip>
              </td>
              {order.map((m) => (
                <td key={m} className={clsx("py-1 text-center font-mono tnum", m === best && "font-semibold text-good")}>
                  {meanRank[m] == null ? "—" : meanRank[m]!.toFixed(1)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="pt-3 text-[11.5px] text-faint">Click a question to see its leaderboard, errors and confusion matrix.</div>
    </div>
  );
}

// ---- R3 / C2: sortable leaderboard ----------------------------------------------------------------

interface Col {
  key: string;
  label: string;
  f: (m: ModelMetrics) => number;
  fmt: (v: number) => string;
  low?: boolean;
  title: string;
  highlight?: boolean;
}

function Leaderboard({
  report,
  ranked,
  color,
  usage,
  rows,
  onReview,
}: {
  report: Report;
  ranked: ModelMetrics[];
  color: (m: string) => string;
  usage: Record<string, UsageRow>;
  rows: number;
  onReview: () => void;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "f1", desc: true });
  const anyCost = ranked.some((m) => (usage[m.model]?.cost_usd ?? 0) > 0);
  const best = ranked[0];
  const second = ranked[1];
  const cols: Col[] = [
    { key: "acc", label: "Accuracy", f: (m) => m.accuracy, fmt: (v) => pct(v), title: "Share of rows where the model's answer matches the ground truth.", highlight: true },
    { key: "f1", label: "Macro F1", f: (m) => m.macro_f1, fmt: (v) => num(v), title: "F1 averaged equally over labels, so rare labels count as much as common ones.", highlight: true },
    { key: "kappa", label: "κ", f: (m) => m.kappa, fmt: (v) => num(v), title: "Cohen's kappa: agreement with the ground truth beyond chance. 0 = chance, 1 = perfect.", highlight: true },
    { key: "wf1", label: "Weighted F1", f: (m) => m.weighted_f1, fmt: (v) => num(v), title: "F1 averaged by how often each label occurs.", highlight: true },
    { key: "prec", label: "Precision", f: (m) => m.macro_precision, fmt: (v) => num(v), title: "Of the rows given a label, the share that truly have it (averaged over labels).", highlight: true },
    { key: "rec", label: "Recall", f: (m) => m.macro_recall, fmt: (v) => num(v), title: "Of the rows that truly have a label, the share the model found (averaged over labels).", highlight: true },
    { key: "ece", label: "ECE", f: (m) => m.ece, fmt: (v) => num(v), low: true, title: "Calibration error: the gap between stated confidence and actual accuracy. Lower is better.", highlight: true },
    { key: "p50", label: "p50", f: (m) => m.latency_p50_ms, fmt: ms, low: true, title: "Median time to answer one row.", highlight: true },
    { key: "p95", label: "p95", f: (m) => m.latency_p95_ms, fmt: ms, low: true, title: "95% of rows were answered within this time.", highlight: true },
    ...(anyCost
      ? [{ key: "cost", label: "Cost", f: (m: ModelMetrics) => usage[m.model]?.cost_usd ?? 0, fmt: usd, low: true, title: "What this evaluation cost, from your per-token prices." }]
      : []),
    { key: "err", label: "Errors", f: (m) => m.errors, fmt: (v) => String(v), low: true, title: "Rows the model failed to answer." },
  ];
  const col = cols.find((c) => c.key === sort.key) ?? cols[1];
  const sorted = [...ranked].sort((a, b) => (sort.desc ? col.f(b) - col.f(a) : col.f(a) - col.f(b)) || b.macro_f1 - a.macro_f1);
  const bestOf = (c: Col) => {
    const vals = ranked.map(c.f);
    return c.low ? Math.min(...vals) : Math.max(...vals);
  };
  const clickSort = (c: Col) => setSort((s) => (s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: !c.low }));

  return (
    <div className="fade-up">
      {ranked.length > 1 && (
        <div className="mb-2 flex items-center gap-2.5 py-1">
          <Trophy className="size-4 shrink-0" style={{ color: color(best.model) }} />
          <div className="text-[13px]">
            <b>{shortModel(best.model)}</b> leads with macro F1 <b className="tnum">{num(best.macro_f1)}</b>
            {second && (
              <span className="text-muted-foreground">
                {" "}
                — {((best.macro_f1 - second.macro_f1) * 100).toFixed(1)} pts ahead of {shortModel(second.model)}
                {best.latency_p50_ms > 0 && second.latency_p50_ms > 0 && (
                  <>
                    ,{" "}
                    {best.latency_p50_ms <= second.latency_p50_ms
                      ? `${(second.latency_p50_ms / best.latency_p50_ms).toFixed(1)}× faster`
                      : `${(best.latency_p50_ms / second.latency_p50_ms).toFixed(1)}× slower`}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-[11.5px] text-faint">
          <tr>
            <th className="py-2 pr-3 text-left font-medium">Model</th>
            {cols.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} className="px-2 py-2 text-right font-medium" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <Tooltip content={c.title} side="top">
                    <button onClick={() => clickSort(c)} className={clsx("inline-flex items-center gap-0.5 rounded px-1 hover:text-foreground", active && "text-foreground")}>
                      {active && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                      {c.label}
                    </button>
                  </Tooltip>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m, i) => (
            <tr key={m.model} className="border-t border-border">
              <td className="py-2.5 pr-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-4 font-mono text-[11.5px] text-faint">{i + 1}</span>
                  <span className="size-2.5 rounded-full" style={{ background: color(m.model) }} />
                  <span className="font-medium">{shortModel(m.model)}</span>
                </div>
              </td>
              {cols.map((c) => {
                const v = c.f(m);
                const isBest = c.highlight && ranked.length > 1 && v === bestOf(c);
                const tip =
                  c.key === "cost" && usage[m.model] ? `${usage[m.model].input_tokens.toLocaleString()} input tokens · ${usd((usage[m.model].cost_usd / Math.max(1, rows)) * 1000)} per 1k rows` : undefined;
                return (
                  <td
                    key={c.key}
                    title={tip}
                    className={clsx(
                      "px-3 py-2.5 text-right font-mono text-[12.5px] tnum",
                      isBest ? "font-semibold text-good" : c.key === "err" ? (m.errors ? "text-bad" : "text-faint") : "text-foreground/85",
                    )}
                  >
                    {c.key === "cost" && !usage[m.model] ? "—" : c.fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 pt-2 text-[11.5px] text-faint">
        <span>
          {report.labels.length} labels · scored on {ranked[0].evaluated - ranked[0].errors} rows · best value per column in green · click a column to sort
        </span>
        {report.reviewed_rows > 0 && (
          <button onClick={onReview} className="ml-auto">
            <Badge tone="accent">
              <Check className="size-3" strokeWidth={3} />
              {report.reviewed_rows} row{report.reviewed_rows === 1 ? "" : "s"} human-reviewed
            </Badge>
          </button>
        )}
      </div>
    </div>
  );
}

function ModelDeepDive({ report, color }: { report: Report; color: (m: string) => string }) {
  const [model, setModel] = useState(report.models[0].model);
  const m = report.models.find((x) => x.model === model) ?? report.models[0];
  return (
    <section className="mt-8 border-t border-border pt-6">
      <CardHeader
        className="px-0 pt-0"
        title="Per-model breakdown"
        subtitle="Where each model gets confused, and whether its confidence can be trusted."
        actions={<Segmented size="sm" value={m.model} onChange={setModel} options={report.models.map((x) => ({ value: x.model, label: shortModel(x.model) }))} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px] gap-8">
        <div className="min-w-0">
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">Confusion matrix</div>
          <ConfusionMatrix labels={report.labels} matrix={m.confusion} color={color(m.model)} />
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">Per label</div>
          <div className="max-h-[300px] overflow-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-[11.5px] text-faint">
                <tr>
                  <th className="py-1 text-left font-medium">Label</th>
                  <th className="py-1 text-right font-medium">n</th>
                  <th className="py-1 text-right font-medium">Prec.</th>
                  <th className="py-1 text-right font-medium">Recall</th>
                  <th className="w-24 py-1 pl-3 text-left font-medium">F1</th>
                </tr>
              </thead>
              <tbody>
                {m.per_class.map((c) => (
                  <tr key={c.label} className="border-t border-border">
                    <td className="py-1.5" title={c.label}>
                      <div className="max-w-[120px] truncate">{c.label}</div>
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] text-faint tnum">{c.support}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] tnum">{num(c.precision, 2)}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] tnum">{num(c.recall, 2)}</td>
                    <td className="py-1.5 pl-3">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-card">
                          <div className="h-full rounded-full" style={{ width: `${c.f1 * 100}%`, background: color(m.model) }} />
                        </div>
                        <span className="w-8 text-right font-mono text-[11.5px] tnum">{num(c.f1, 2)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">Calibration</div>
          <Reliability bins={m.calibration} color={color(m.model)} size={200} />
          <div className="mt-2 text-[11.5px] leading-relaxed text-faint">
            Bars on the dashed line = confidence matches accuracy. ECE <span className="font-mono text-foreground">{num(m.ece)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Agreement({ report, color }: { report: Report; color: (m: string) => string }) {
  const [mode, setMode] = useState<"pct" | "kappa">("pct");
  const ms_ = report.models.map((m) => m.model);
  const hasKappa = report.pairwise_kappa?.length === ms_.length;
  return (
    <section className="mt-8 border-t border-border pt-6">
      <CardHeader
        className="px-0 pt-0"
        title="Model agreement"
        subtitle={
          mode === "pct"
            ? "How often two models give the same answer. Low agreement with similar accuracy suggests an ensemble could help."
            : "Cohen's κ between two models: agreement beyond what chance alone would produce (0 = chance, 1 = identical)."
        }
        actions={
          hasKappa && (
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "pct", label: "% agreement" },
                { value: "kappa", label: "κ" },
              ]}
            />
          )
        }
      />
      <div className="overflow-auto">
        <table className="text-[12px]">
          <thead>
            <tr>
              <th />
              {ms_.map((m) => (
                <th key={m} className="px-1 pb-1.5 font-medium text-muted-foreground">
                  <span className="flex items-center justify-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ background: color(m) }} />
                    {shortModel(m)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ms_.map((a, i) => (
              <tr key={a}>
                <td className="pr-3 text-right font-medium text-muted-foreground">{shortModel(a)}</td>
                {ms_.map((b, j) => {
                  const v = mode === "kappa" ? report.pairwise_kappa[i][j] : report.agreement[i][j];
                  return (
                    <td key={b} className="p-0.5">
                      <div
                        className="grid h-9 w-24 place-items-center rounded-md font-mono text-[11.5px] tnum"
                        title={mode === "kappa" && i !== j ? `κ = ${num(v)} (${kappaWord(v)})` : undefined}
                        style={{ background: i === j ? "var(--card)" : heat(v), color: i === j ? "var(--faint)" : v > 0.75 ? "#fff" : "var(--foreground)" }}
                      >
                        {i === j ? "—" : mode === "kappa" ? num(v, 2) : pct(v, 0)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.fleiss_kappa != null && (
        <div className="mt-3 text-[12.5px] text-muted-foreground">
          <Tooltip content="Agreement among all models at once, beyond chance. Common in content analysis to report inter-coder reliability.">
            <span className="cursor-help border-b border-dotted border-faint">Fleiss' κ</span>
          </Tooltip>{" "}
          across all {ms_.length} models: <b className="font-mono text-foreground tnum">{num(report.fleiss_kappa)}</b> <span className="text-faint">({kappaWord(report.fleiss_kappa)})</span>
        </div>
      )}
    </section>
  );
}

// ---- predictions explorer with R5 / C1 corrections ----------------------------------------------

const PAGE = 40;

function PredictionsExplorer({
  id,
  datasetId,
  config,
  task,
  models,
  color,
  tick,
  onChanged,
}: {
  id: string;
  datasetId: string;
  /** The evaluation's setup, so "Open in Playground" brings its questions. */
  config: ExperimentConfig;
  task: TaskSpec;
  models: string[];
  color: (m: string) => string;
  tick: number;
  onChanged: () => void;
}) {
  const { go, toast } = useApp();
  const [filter, setFilter] = useState<"all" | "wrong" | "disagree" | "model">("wrong");
  const [model, setModel] = useState(models[0]);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<PredictionRow> | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [relabel, setRelabel] = useState<{ row: PredictionRow; value: string; note: string } | null>(null);
  const question = task.id;

  const f = filter === "model" ? `wrong:${model}` : filter;
  useEffect(() => {
    setOffset(0);
  }, [f]);
  useEffect(() => {
    api.predictions(id, question, f, offset, PAGE).then(setPage).catch(() => setPage({ rows: [], total: 0 }));
  }, [id, question, f, offset, tick]);

  const act = async (row: number, fn: () => Promise<void>, msg: string) => {
    setBusyRow(row);
    try {
      await fn();
      toast(msg, "good");
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusyRow(null);
    }
  };
  const confirm = (r: PredictionRow) => act(r.row_idx, () => api.setCorrection(datasetId, r.row_idx, task.label_column, r.ground_truth, null), `Row ${r.row_idx + 1}: ground truth confirmed`);
  const undo = (r: PredictionRow) => act(r.row_idx, () => api.clearCorrection(datasetId, r.row_idx, task.label_column), `Row ${r.row_idx + 1}: back to “${r.original_ground_truth ?? "original"}”`);
  const saveRelabel = async () => {
    if (!relabel) return;
    const { row, value, note } = relabel;
    setRelabel(null);
    await act(row.row_idx, () => api.setCorrection(datasetId, row.row_idx, task.label_column, value, note.trim() || null), `Row ${row.row_idx + 1} relabelled “${value}”`);
  };

  return (
    <section className="mt-8 border-t border-border pt-6">
      <CardHeader
        className="px-0 pt-0"
        title="Predictions"
        subtitle={page ? `${page.total.toLocaleString()} rows · hover a row to confirm or fix its ground truth` : undefined}
        actions={
          <>
            {filter === "model" && <Select value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: shortModel(m) }))} />}
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "wrong", label: "Any wrong" },
                { value: "model", label: "Wrong by model" },
                { value: "disagree", label: "Disagreements" },
                { value: "all", label: "All" },
              ]}
            />
          </>
        }
      />
      <div className="overflow-auto border-t border-border" data-selectable>
        <table className="w-full text-[12.5px]">
          <thead className="bg-card/60 text-[11.5px] text-faint">
            <tr>
              <th className="w-12 px-4 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Input</th>
              <th className="px-3 py-2 text-left font-medium">Ground truth</th>
              {models.map((m) => (
                <th key={m} className="px-3 py-2 text-left font-medium">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ background: color(m) }} />
                    {shortModel(m)}
                  </span>
                </th>
              ))}
              <th className="w-[1%] px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((r) => {
              const confirmed = r.corrected && (r.original_ground_truth == null || r.original_ground_truth === r.ground_truth);
              return (
                <tr key={r.row_idx} className="group border-t border-border align-top hover:bg-sel/40">
                  <td className="px-4 py-2 font-mono text-[11px] text-faint tnum">{r.row_idx + 1}</td>
                  <td className="cursor-pointer px-3 py-2" onClick={() => setOpen(open === r.row_idx ? null : r.row_idx)}>
                    <div className={clsx("max-w-[380px]", open === r.row_idx ? "whitespace-pre-wrap break-words" : "truncate")}>
                      <InputText input={r.input} expanded={open === r.row_idx} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 font-medium">
                      {r.ground_truth}
                      {r.corrected && (
                        <Tooltip
                          content={
                            <span>
                              {confirmed ? "Confirmed by a human" : `Corrected — originally “${r.original_ground_truth}”`}
                              {r.review_note ? ` · ${r.review_note}` : ""}
                            </span>
                          }
                        >
                          <span>
                            <Badge tone={confirmed ? "good" : "accent"}>{confirmed ? "confirmed" : "corrected"}</Badge>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    {r.corrected && !confirmed && <div className="text-[11.5px] text-faint line-through">{r.original_ground_truth}</div>}
                    {r.review_note && <div className="max-w-[180px] truncate text-[11.5px] text-muted-foreground">“{r.review_note}”</div>}
                  </td>
                  {models.map((m) => {
                    const c = r.by_model[m];
                    const ok = c?.predicted === r.ground_truth;
                    return (
                      <td key={m} className="px-3 py-2">
                        {c?.predicted ? (
                          <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5", ok ? "text-good" : "bg-bad-soft text-bad")}>
                            {ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
                            {c.predicted}
                            {c.confidence !== null && <span className="ml-0.5 font-mono text-[11px] opacity-60">{pct(c.confidence, 0)}</span>}
                          </span>
                        ) : (
                          <span className="text-[11.5px] text-faint" title={c?.error ?? ""}>
                            {c?.error === "pending" ? "…" : "error"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5">
                    {busyRow === r.row_idx ? (
                      <Spinner delay={0} />
                    ) : (
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {r.corrected ? (
                          <Tooltip content="Undo the correction">
                            <Button size="icon" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => undo(r)} />
                          </Tooltip>
                        ) : (
                          <Tooltip content="Ground truth is right">
                            <Button size="icon" variant="ghost" icon={<Check className="size-3.5" />} onClick={() => confirm(r)} />
                          </Tooltip>
                        )}
                        <Tooltip content="Relabel…">
                          <Button size="icon" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setRelabel({ row: r, value: r.ground_truth, note: r.review_note ?? "" })} />
                        </Tooltip>
                        <Tooltip content="Open in Playground">
                          <Button size="icon" variant="ghost" icon={<SquareArrowOutUpRight className="size-3.5" />} onClick={async () => {
                              await openSetupInPlayground({ config, datasetId, row: r.row_idx, models });
                              go({ page: "quick" });
                            }}
                          />
                        </Tooltip>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {page && page.rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">Nothing here{filter !== "all" ? " — every model got these right" : ""}.</div>}
      </div>
      {page && page.total > PAGE && (
        <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-[12px] text-muted-foreground">
          <span className="tnum">
            {offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total.toLocaleString()}
          </span>
          <div className="flex gap-1">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button size="sm" disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={!!relabel}
        onClose={() => setRelabel(null)}
        title={relabel ? `Relabel row ${relabel.row.row_idx + 1}` : "Relabel"}
        width={440}
        footer={
          <>
            <Button onClick={() => setRelabel(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveRelabel}>
              Save
            </Button>
          </>
        }
      >
        {relabel && (
          <div className="w-[368px] max-w-full space-y-3">
            <div className="max-h-28 overflow-auto rounded-[8px] bg-card px-3 py-2 text-[12.5px] text-muted-foreground" data-selectable>
              <InputText input={relabel.row.input} expanded />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-right text-muted-foreground">Ground truth:</span>
              <Select value={relabel.value} onChange={(value) => setRelabel({ ...relabel, value })} options={task.labels.map((l) => ({ value: l.value, label: l.value }))} />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-right text-muted-foreground">Note:</span>
              <Input className="flex-1" value={relabel.note} onChange={(note) => setRelabel({ ...relabel, note })} placeholder="Optional reason" />
            </div>
            <div className="pl-26 text-[11.5px] text-faint">Corrections are stored with the dataset and apply to every evaluation on it. The original value is kept.</div>
          </div>
        )}
      </Modal>
    </section>
  );
}

/** Multi-column inputs arrive as a JSON object; show them as `key value` pairs. */
export function InputText({ input, expanded }: { input: string; expanded: boolean }) {
  if (!input.startsWith("{")) return <>{input}</>;
  try {
    const obj = JSON.parse(input) as Record<string, string>;
    return (
      <>
        {Object.entries(obj).map(([k, v], i) => (
          <span key={k} className={clsx(expanded && "block")}>
            {i > 0 && !expanded && <span className="text-faint"> · </span>}
            <span className="mr-1 font-mono text-[11px] text-faint">{k}</span>
            {v}
          </span>
        ))}
      </>
    );
  } catch {
    return <>{input}</>;
  }
}

/** One model's progress in a running evaluation; shows the warm-up while it loads into memory. */
function RunningModelRow({ model, done, total, color, current, warmingSince }: { model: string; done: number; total: number; color: string; current: boolean; warmingSince: number | null }) {
  // Before its first answer, the current model may still be loading (also when the page opened after the load began).
  const { state, since } = useModelState(model, current && done === 0);
  const loading = warmingSince !== null || (current && done === 0 && state === "loading");
  return (
    <div className="grid grid-cols-[10rem_1fr_5rem] items-center gap-3 text-[12.5px]">
      <span className="flex items-center gap-2 truncate">
        <span className="size-2 rounded-full" style={{ background: color }} />
        {shortModel(model)}
      </span>
      {loading ? <ModelLoading model={model} since={warmingSince ?? since} compact /> : <Progress value={done / total} color={color} />}
      <span className="text-right font-mono text-[11.5px] text-muted-foreground tnum">
        {done}/{total}
      </span>
    </div>
  );
}
