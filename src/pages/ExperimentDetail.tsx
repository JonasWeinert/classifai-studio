import clsx from "clsx";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, Play, Square, Trash2, Trophy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfusionMatrix, MetricBars, Reliability } from "../components/charts";
import { Badge, Button, Card, CardHeader, ErrorNote, Modal, PageHeader, Progress, Segmented, Select, Spinner } from "../components/ui";
import { api, errorMessage, events, pickSavePath } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, modelColor, ms, num, pct, shortModel } from "../lib/format";
import type { Experiment, ExperimentStatus, ModelMetrics, Page, PredictionRow, Report } from "../lib/types";

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
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
      {label}
    </Badge>
  );
}

export function ExperimentDetail({ id }: { id: string }) {
  const { go, toast } = useApp();
  const [exp, setExp] = useState<Experiment | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tick, setTick] = useState(0); // bumps when predictions change, to refresh the table

  const load = useCallback(async () => {
    try {
      const [e, r] = await Promise.all([api.experiment(id), api.report(id)]);
      setExp(e);
      setReport(r);
      setTick((t) => t + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Live progress: patch counts from events, refresh metrics at most every 1.5 s.
  const lastRefresh = useRef(0);
  useEffect(() => {
    const un = events.progress((ev) => {
      if (ev.experiment_id !== id) return;
      if (ev.message !== undefined) setMessage(ev.message);
      setExp((e) => (e ? { ...e, status: ev.status, progress: ev.model ? { ...e.progress, [ev.model]: ev.done } : e.progress } : e));
      const now = Date.now();
      if (ev.status !== "running" || now - lastRefresh.current > 1500) {
        lastRefresh.current = now;
        load();
      }
    });
    return () => void un.then((f) => f());
  }, [id, load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!exp || !report) return <Spinner />;

  const total = exp.row_indices.length;
  const running = exp.status === "running" || exp.status === "pending";
  const doneAll = Object.values(exp.progress).reduce((a, b) => a + b, 0);
  const color = (m: string) => modelColor(exp.config.models.indexOf(m));
  const scored = report.models.filter((m) => m.evaluated - m.errors > 0);
  const ranked = [...scored].sort((a, b) => b.macro_f1 - a.macro_f1 || b.accuracy - a.accuracy);

  const exportCsv = async () => {
    const path = await pickSavePath(`${exp.name.replace(/[^\w.-]+/g, "_")}.csv`);
    if (!path) return;
    try {
      const n = await api.exportCsv(id, path);
      toast(`Exported ${n} rows`, "good");
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <>
      <PageHeader
        back={
          <button onClick={() => go({ page: "experiments" })} className="flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
            <ArrowLeft className="size-3.5" /> Experiments
          </button>
        }
        title={
          <span className="flex items-center gap-3">
            {exp.name} <StatusBadge status={exp.status} />
          </span>
        }
        subtitle={
          <span>
            <button className="hover:text-fg hover:underline" onClick={() => go({ page: "dataset", id: exp.dataset_id })}>
              {exp.dataset_name}
            </button>
            {" · "}
            {total.toLocaleString()} rows · {exp.config.task.kind === "binary" ? "yes/no" : `${exp.config.task.labels.length} labels`} · “{exp.config.task.instructions}” · {ago(exp.created_at)}
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
                <Button icon={<Play className="size-3.5" />} onClick={async () => { await api.experimentStart(id); load(); }}>
                  Resume
                </Button>
              )
            )}
            <Button icon={<Download className="size-3.5" />} onClick={exportCsv}>
              Export CSV
            </Button>
            <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)} />
          </>
        }
      />

      {exp.error && <div className="mb-4"><ErrorNote>{exp.error}</ErrorNote></div>}

      {running && (
        <Card className="mb-5 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[13.5px] font-semibold">Running…</div>
            <div className="text-[12px] text-muted">{message ?? `${doneAll.toLocaleString()} / ${(total * exp.config.models.length).toLocaleString()} decisions`}</div>
          </div>
          <div className="space-y-2.5">
            {exp.config.models.map((m) => (
              <div key={m} className="grid grid-cols-[10rem_1fr_5rem] items-center gap-3 text-[12.5px]">
                <span className="flex items-center gap-2 truncate">
                  <span className="size-2 rounded-full" style={{ background: color(m) }} />
                  {shortModel(m)}
                </span>
                <Progress value={(exp.progress[m] ?? 0) / total} color={color(m)} />
                <span className="text-right font-mono text-[11.5px] text-muted tnum">
                  {exp.progress[m] ?? 0}/{total}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {ranked.length > 0 && <Leaderboard report={report} ranked={ranked} color={color} />}

      {ranked.length > 0 && (
        <div className="mt-5 grid grid-cols-3 gap-5">
          <Card className="p-5">
            <div className="mb-3 text-[12.5px] font-semibold">Accuracy</div>
            <MetricBars items={scored.map((m) => ({ label: shortModel(m.model), value: m.accuracy, color: color(m.model) }))} format={(v) => pct(v)} />
          </Card>
          <Card className="p-5">
            <div className="mb-3 text-[12.5px] font-semibold">Macro F1</div>
            <MetricBars items={scored.map((m) => ({ label: shortModel(m.model), value: m.macro_f1, color: color(m.model) }))} format={(v) => num(v)} />
          </Card>
          <Card className="p-5">
            <div className="mb-3 text-[12.5px] font-semibold">Median latency <span className="font-normal text-faint">· lower is better</span></div>
            <MetricBars higherIsBetter={false} items={scored.map((m) => ({ label: shortModel(m.model), value: m.latency_p50_ms, color: color(m.model) }))} format={ms} />
          </Card>
        </div>
      )}

      {ranked.length > 0 && <ModelDeepDive report={{ ...report, models: scored }} color={color} />}

      {report.models.length > 1 && ranked.length > 1 && <Agreement report={report} color={color} />}

      <PredictionsExplorer id={id} models={exp.config.models} color={color} tick={tick} />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete experiment?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="primary" className="!bg-bad" onClick={async () => { await api.experimentDelete(id); go({ page: "experiments" }); }}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">All predictions of “{exp.name}” are removed. The dataset stays.</p>
      </Modal>
    </>
  );
}

function Leaderboard({ report, ranked, color }: { report: Report; ranked: ModelMetrics[]; color: (m: string) => string }) {
  const best = ranked[0];
  const second = ranked[1];
  const bestOf = (f: (m: ModelMetrics) => number, low = false) => {
    const vals = ranked.map(f);
    return low ? Math.min(...vals) : Math.max(...vals);
  };
  const cols: { key: string; label: string; f: (m: ModelMetrics) => number; fmt: (v: number) => string; low?: boolean; title: string }[] = [
    { key: "acc", label: "Accuracy", f: (m) => m.accuracy, fmt: (v) => pct(v), title: "Share of rows where the prediction equals the ground truth" },
    { key: "f1", label: "Macro F1", f: (m) => m.macro_f1, fmt: (v) => num(v), title: "Unweighted mean F1 over labels — robust to class imbalance" },
    { key: "wf1", label: "Weighted F1", f: (m) => m.weighted_f1, fmt: (v) => num(v), title: "F1 averaged by label frequency" },
    { key: "prec", label: "Precision", f: (m) => m.macro_precision, fmt: (v) => num(v), title: "Macro-averaged precision" },
    { key: "rec", label: "Recall", f: (m) => m.macro_recall, fmt: (v) => num(v), title: "Macro-averaged recall" },
    { key: "ece", label: "ECE", f: (m) => m.ece, fmt: (v) => num(v), low: true, title: "Expected calibration error: how far confidence is from actual accuracy (lower is better)" },
    { key: "p50", label: "p50", f: (m) => m.latency_p50_ms, fmt: ms, low: true, title: "Median inference time per row" },
    { key: "p95", label: "p95", f: (m) => m.latency_p95_ms, fmt: ms, low: true, title: "95th percentile inference time" },
  ];

  return (
    <Card className="overflow-hidden">
      {ranked.length > 1 && (
        <div className="flex items-center gap-3 border-b border-line bg-gradient-to-r from-accent-soft to-transparent px-5 py-3.5">
          <div className="grid size-8 place-items-center rounded-lg text-white" style={{ background: color(best.model) }}>
            <Trophy className="size-4" />
          </div>
          <div className="text-[13px]">
            <b>{shortModel(best.model)}</b> leads with macro F1 <b className="tnum">{num(best.macro_f1)}</b>
            {second && (
              <span className="text-muted">
                {" "}— {((best.macro_f1 - second.macro_f1) * 100).toFixed(1)} pts ahead of {shortModel(second.model)}
                {best.latency_p50_ms > 0 && second.latency_p50_ms > 0 && (
                  <>
                    , {best.latency_p50_ms <= second.latency_p50_ms ? `${(second.latency_p50_ms / best.latency_p50_ms).toFixed(1)}× faster` : `${(best.latency_p50_ms / second.latency_p50_ms).toFixed(1)}× slower`}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      <table className="w-full text-[13px]">
        <thead className="text-[11.5px] text-faint">
          <tr>
            <th className="px-5 py-2.5 text-left font-medium">Model</th>
            {cols.map((c) => (
              <th key={c.key} className="px-3 py-2.5 text-right font-medium" title={c.title}>
                {c.label}
              </th>
            ))}
            <th className="px-5 py-2.5 text-right font-medium">Errors</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((m, i) => (
            <tr key={m.model} className="border-t border-line">
              <td className="px-5 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-4 font-mono text-[11px] text-faint">{i + 1}</span>
                  <span className="size-2.5 rounded-full" style={{ background: color(m.model) }} />
                  <span className="font-medium">{shortModel(m.model)}</span>
                </div>
              </td>
              {cols.map((c) => {
                const v = c.f(m);
                const isBest = ranked.length > 1 && v === bestOf(c.f, c.low);
                return (
                  <td key={c.key} className={clsx("px-3 py-3 text-right font-mono text-[12.5px] tnum", isBest ? "font-semibold text-good" : "text-fg/85")}>
                    {c.fmt(v)}
                  </td>
                );
              })}
              <td className={clsx("px-5 py-3 text-right font-mono text-[12.5px] tnum", m.errors ? "text-bad" : "text-faint")}>{m.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-line px-5 py-2 text-[11.5px] text-faint">
        {report.labels.length} labels · scored on {ranked[0].evaluated - ranked[0].errors} rows · best value per column in green
      </div>
    </Card>
  );
}

function ModelDeepDive({ report, color }: { report: Report; color: (m: string) => string }) {
  const [model, setModel] = useState(report.models[0].model);
  const m = report.models.find((x) => x.model === model) ?? report.models[0];
  return (
    <Card className="mt-5">
      <CardHeader
        title="Per-model breakdown"
        subtitle="Where each model gets confused, and whether its confidence can be trusted."
        actions={<Segmented size="sm" value={model} onChange={setModel} options={report.models.map((x) => ({ value: x.model, label: shortModel(x.model) }))} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px] gap-6 px-5 pb-5">
        <div className="min-w-0">
          <div className="mb-2 text-[12px] font-medium text-muted">Confusion matrix</div>
          <ConfusionMatrix labels={report.labels} matrix={m.confusion} color={color(m.model)} />
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-[12px] font-medium text-muted">Per label</div>
          <div className="max-h-[300px] overflow-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-[11px] text-faint">
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
                  <tr key={c.label} className="border-t border-line">
                    <td className="max-w-[120px] truncate py-1.5" title={c.label}>{c.label}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] text-faint tnum">{c.support}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] tnum">{num(c.precision, 2)}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] tnum">{num(c.recall, 2)}</td>
                    <td className="py-1.5 pl-3">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                          <div className="h-full rounded-full" style={{ width: `${c.f1 * 100}%`, background: color(m.model) }} />
                        </div>
                        <span className="w-8 text-right font-mono text-[11px] tnum">{num(c.f1, 2)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="mb-2 text-[12px] font-medium text-muted">Calibration</div>
          <Reliability bins={m.calibration} color={color(m.model)} size={200} />
          <div className="mt-2 text-[11.5px] leading-relaxed text-faint">
            Bars on the dashed line = confidence matches accuracy. ECE <span className="font-mono text-fg">{num(m.ece)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Agreement({ report, color }: { report: Report; color: (m: string) => string }) {
  const ms_ = report.models.map((m) => m.model);
  return (
    <Card className="mt-5">
      <CardHeader title="Model agreement" subtitle="How often two models give the same answer. Low agreement with similar accuracy suggests an ensemble could help." />
      <div className="overflow-auto px-5 pb-5">
        <table className="text-[12px]">
          <thead>
            <tr>
              <th />
              {ms_.map((m) => (
                <th key={m} className="px-1 pb-1.5 font-medium text-muted">
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
                <td className="pr-3 text-right font-medium text-muted">{shortModel(a)}</td>
                {ms_.map((b, j) => {
                  const v = report.agreement[i][j];
                  return (
                    <td key={b} className="p-0.5">
                      <div
                        className="grid h-9 w-24 place-items-center rounded-md font-mono text-[11.5px] tnum"
                        style={{ background: i === j ? "var(--panel-2)" : `color-mix(in srgb, var(--accent) ${Math.round(v * 70)}%, transparent)`, color: i === j ? "var(--faint)" : v > 0.6 ? "#fff" : "var(--fg)" }}
                      >
                        {i === j ? "—" : pct(v, 0)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const PAGE = 40;

function PredictionsExplorer({ id, models, color, tick }: { id: string; models: string[]; color: (m: string) => string; tick: number }) {
  const [filter, setFilter] = useState<"all" | "wrong" | "disagree" | "model">("wrong");
  const [model, setModel] = useState(models[0]);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<PredictionRow> | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const f = filter === "model" ? `wrong:${model}` : filter;
  useEffect(() => {
    setOffset(0);
  }, [f]);
  useEffect(() => {
    api.predictions(id, f, offset, PAGE).then(setPage).catch(() => setPage({ rows: [], total: 0 }));
  }, [id, f, offset, tick]);

  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Predictions"
        subtitle={page ? `${page.total.toLocaleString()} rows` : undefined}
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
      <div className="overflow-auto border-t border-line" data-selectable>
        <table className="w-full text-[12.5px]">
          <thead className="bg-panel-2/60 text-[11px] text-faint">
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
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((r) => (
              <tr key={r.row_idx} className="border-t border-line align-top hover:bg-panel-2/40">
                <td className="px-4 py-2 font-mono text-[10.5px] text-faint tnum">{r.row_idx + 1}</td>
                <td className="max-w-[420px] cursor-pointer px-3 py-2" onClick={() => setOpen(open === r.row_idx ? null : r.row_idx)}>
                  <div className={clsx(open === r.row_idx ? "whitespace-pre-wrap" : "truncate")}>
                    <InputText input={r.input} expanded={open === r.row_idx} />
                  </div>
                </td>
                <td className="px-3 py-2 font-medium">{r.ground_truth}</td>
                {models.map((m) => {
                  const c = r.by_model[m];
                  const ok = c?.predicted === r.ground_truth;
                  return (
                    <td key={m} className="px-3 py-2">
                      {c?.predicted ? (
                        <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5", ok ? "text-good" : "bg-bad-soft text-bad")}>
                          {ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
                          {c.predicted}
                          {c.confidence !== null && <span className="ml-0.5 font-mono text-[10.5px] opacity-60">{pct(c.confidence, 0)}</span>}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-faint" title={c?.error ?? ""}>{c?.error === "pending" ? "…" : "error"}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {page && page.rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted">Nothing here{filter !== "all" ? " — every model got these right" : ""}.</div>}
      </div>
      {page && page.total > PAGE && (
        <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-[12px] text-muted">
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
    </Card>
  );
}

/** Multi-column inputs arrive as a JSON object; show them as `key value` pairs. */
function InputText({ input, expanded }: { input: string; expanded: boolean }) {
  if (!input.startsWith("{")) return <>{input}</>;
  try {
    const obj = JSON.parse(input) as Record<string, string>;
    return (
      <>
        {Object.entries(obj).map(([k, v], i) => (
          <span key={k} className={clsx(expanded && "block")}>
            {i > 0 && !expanded && <span className="text-faint"> · </span>}
            <span className="mr-1 font-mono text-[10.5px] text-faint">{k}</span>
            {v}
          </span>
        ))}
      </>
    );
  } catch {
    return <>{input}</>;
  }
}
