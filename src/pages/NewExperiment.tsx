import { cn } from "@/lib/utils";
import { AlertCircle, Merge, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ModelPicker } from "../components/ModelPicker";
import { Badge, Button, Checkbox, Disclosure, ErrorNote, FormRow, Input, Modal, PageHeader, Section, Segmented, Select, Spinner, Textarea, Tooltip } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { modelColor, shortModel, usd } from "../lib/format";
import { defaultInstructions, guessPositive, labelKey } from "../lib/labels";
import { slugId } from "../lib/questions";
import type { Dataset, Estimate, Experiment, ExperimentConfig, LabelSpec, QuestionSet, TaskKind, ValueCount } from "../lib/types";

interface LabelRow extends ValueCount {
  include: boolean;
  description: string;
  /** Other spellings merged into this label. */
  aliases: string[];
}

/** What to apply once a question's label values have loaded (from a duplicated experiment or a question set). */
interface Seed {
  kind: TaskKind;
  /** Labels of a duplicated experiment: which are included, their descriptions and aliases. */
  specs?: LabelSpec[];
  /** Label descriptions by lower-cased name (from a question set's options). */
  descs?: Record<string, string>;
  yes?: string;
  no?: string;
  positive?: string | null;
}

interface QDraft {
  key: number;
  column: string;
  kind: TaskKind;
  instructions: string;
  instructionsTouched: boolean;
  context: string;
  labels: LabelRow[] | null;
  positive: string;
  seed?: Seed;
}

interface Prefill {
  datasetId: string;
  inputs: string[];
  context: string;
  qs: QDraft[];
  models?: string[];
  sample?: string;
  name?: string;
}

type Field = "dataset" | "inputs" | "questions" | "models" | `q:${number}`;
interface Problem {
  field: Field;
  msg: string;
}

let nextKey = 1;
const blankQuestion = (column: string, seed?: Seed, extra: Partial<QDraft> = {}): QDraft => ({
  key: nextKey++,
  column,
  kind: seed?.kind ?? "choice",
  instructions: "",
  instructionsTouched: false,
  context: "",
  labels: null,
  positive: "",
  seed,
  ...extra,
});

/** Merge label `from` into label `into`: counts add up, the spelling becomes an alias. */
function mergeRows(rows: LabelRow[], from: string, into: string): LabelRow[] {
  const src = rows.find((r) => r.value === from);
  if (!src || from === into) return rows;
  return rows
    .filter((r) => r.value !== from)
    .map((r) => (r.value === into ? { ...r, count: r.count + src.count, aliases: [...r.aliases, src.value, ...src.aliases], description: r.description || src.description, include: r.include || src.include } : r));
}

/** Groups of labels that differ only by case, whitespace or punctuation. Each group's first entry is the most frequent. */
function variantGroups(rows: LabelRow[]): LabelRow[][] {
  const by = new Map<string, LabelRow[]>();
  rows.forEach((r) => {
    const k = labelKey(r.value);
    if (!k) return;
    by.set(k, [...(by.get(k) ?? []), r]);
  });
  return [...by.values()].filter((g) => g.length > 1).map((g) => [...g].sort((a, b) => b.count - a.count));
}

/** Build label rows from value counts and apply a question's seed. */
function loadLabels(q: QDraft, vc: ValueCount[]): Partial<QDraft> {
  let rows: LabelRow[] = vc.filter((v) => v.value !== "").map((v, i) => ({ ...v, include: i < 255, description: "", aliases: [] }));
  const s = q.seed;
  if (s?.specs) {
    for (const sp of s.specs) {
      for (const a of sp.aliases ?? []) {
        if (rows.some((r) => r.value === sp.value)) rows = mergeRows(rows, a, sp.value);
      }
    }
    rows = rows.map((r) => {
      const sp = s.specs!.find((x) => x.value === r.value);
      return { ...r, include: !!sp, description: sp?.description ?? "" };
    });
  }
  if (s?.descs) rows = rows.map((r) => ({ ...r, description: r.description || s.descs![r.value.trim().toLowerCase()] || "" }));
  const kind: TaskKind = s?.kind ?? (rows.length === 2 ? "binary" : "choice");
  const included = rows.filter((r) => r.include);
  const positive = s?.positive && rows.some((r) => r.value === s.positive) ? s.positive : guessPositive(included.length ? included : rows);
  if (kind === "binary" && (s?.yes || s?.no)) {
    rows = rows.map((r) => (r.value === positive ? { ...r, description: r.description || s.yes || "" } : r.include ? { ...r, description: r.description || s.no || "" } : r));
  }
  return { labels: rows, kind, positive, instructions: q.instructionsTouched ? q.instructions : defaultInstructions(q.column, kind, positive) };
}

const fmtTime = (s: number) => (s < 60 ? `~${Math.max(1, Math.round(s))} s` : s < 3600 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`);
const fmtCost = (v: number) => (v === 0 ? "free" : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);

export function NewExperiment({ datasetId: datasetIdProp }: { datasetId?: string }) {
  const { go, models, toast, route } = useApp();
  const r = route.page === "new-experiment" ? route : null;
  const datasetId = datasetIdProp ?? r?.datasetId;
  const fromExperiment = r?.fromExperiment;
  const fromSet = r?.fromSet;

  const datasets = useAsync(() => api.datasets(), []);
  const sets = useAsync(() => api.questionSets(), []);
  const [dsId, setDsId] = useState<string | undefined>(datasetId);
  const ds: Dataset | undefined = datasets.data?.find((d) => d.id === dsId);

  const [inputs, setInputs] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [qs, setQs] = useState<QDraft[]>([]);
  const [selModels, setSelModels] = useState<string[]>([]);
  const [sample, setSample] = useState("200");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);
  const [confirmCost, setConfirmCost] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const prefill = useRef<Prefill | null>(null);
  const [expTick, setExpTick] = useState(0);
  const [setTick, setSetTick] = useState(0);
  const pendingSet = useRef<QuestionSet | null>(null);
  const [prefillLoading, setPrefillLoading] = useState(!!(fromExperiment || fromSet));

  // ---- prefill from an experiment ("Duplicate…") or a question set --------------------------------
  useEffect(() => {
    if (!fromExperiment) return;
    api
      .experiment(fromExperiment)
      .then((e: Experiment) => {
        const c = e.config;
        prefill.current = {
          datasetId: c.dataset_id,
          inputs: c.input_columns,
          context: c.context ?? "",
          qs: c.tasks.map((t) =>
            blankQuestion(t.label_column, { kind: t.kind, specs: t.labels, positive: t.positive_label }, { instructions: t.instructions, instructionsTouched: true, context: t.context ?? "", kind: t.kind }),
          ),
          models: c.models,
          sample: c.sample_size ? String(c.sample_size) : undefined,
          name: `${e.name} (copy)`,
        };
        setDsId(c.dataset_id);
        setPrefillLoading(false);
        setExpTick((n) => n + 1);
      })
      .catch((err) => {
        setError(err);
        setPrefillLoading(false);
      });
  }, [fromExperiment]);

  const loadSet = (id: string) =>
    api
      .questionSet(id)
      .then((s) => {
        pendingSet.current = s;
        setPrefillLoading(false);
        setSetTick((n) => n + 1);
      })
      .catch((err) => {
        setError(err);
        setPrefillLoading(false);
      });

  useEffect(() => {
    if (fromSet) loadSet(fromSet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSet]);

  useEffect(() => {
    if (!dsId && datasets.data?.length && !fromExperiment) setDsId(datasets.data[0].id);
  }, [datasets.data, dsId, fromExperiment]);

  // A new dataset resets the setup (or applies a pending prefill for it).
  useEffect(() => {
    if (!ds) return;
    const p = prefill.current;
    if (p && p.datasetId === ds.id) {
      prefill.current = null;
      setInputs(p.inputs.filter((c) => ds.columns.includes(c)));
      setContext(p.context);
      setQs(p.qs.filter((q) => ds.columns.includes(q.column)));
      // Older experiments may store "laya" where the installed name is "laya:latest".
      if (p.models) setSelModels(p.models.map((m) => (models.some((x) => x.name === m) || !models.some((x) => x.name === `${m}:latest`) ? m : `${m}:latest`)));
      if (p.sample) setSample(p.sample);
      if (p.name) {
        setName(p.name);
        setNameTouched(true);
      }
      return;
    }
    if (prefillLoading && fromExperiment) return;
    const l = guessLabelColumn(ds.columns);
    setInputs(guessInputColumns(ds.columns, l));
    setQs([blankQuestion(l)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, expTick]);

  // Apply a question set once the dataset and inputs are known: one question per choice / yes-no question.
  useEffect(() => {
    const s = pendingSet.current;
    if (!s || !ds || inputs.length === 0) return;
    pendingSet.current = null;
    const usable = s.payload.questions.filter((q) => q.kind === "choice" || q.kind === "noul");
    const taken = [...inputs];
    const out: QDraft[] = [];
    for (const sq of usable) {
      const free = ds.columns.filter((c) => !taken.includes(c));
      if (!free.length) break;
      const col = guessLabelColumn(free);
      taken.push(col);
      const descs = Object.fromEntries(sq.options.filter((o) => o.description.trim()).map((o) => [o.name.trim().toLowerCase(), o.description.trim()]));
      out.push(
        blankQuestion(col, { kind: sq.kind === "noul" ? "binary" : "choice", descs, yes: sq.yes, no: sq.no }, { instructions: sq.text, instructionsTouched: !!sq.text.trim(), context: sq.context ?? "" }),
      );
    }
    if (!out.length) {
      toast(`“${s.name}” has no pick-one or yes/no questions`, "bad");
      return;
    }
    if (s.payload.context?.trim()) setContext(s.payload.context);
    setQs(out);
    const skipped = s.payload.questions.length - out.length;
    toast(`Loaded ${out.length} question${out.length === 1 ? "" : "s"} from “${s.name}”${skipped ? ` · ${skipped} skipped (no free column or unsupported type)` : ""}`, skipped ? "neutral" : "good");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, inputs.length, setTick]);

  // Load label values whenever a question's column changes.
  const columnsKey = qs.map((q) => `${q.key}:${q.column}:${q.labels === null}`).join("|");
  useEffect(() => {
    if (!ds) return;
    qs.filter((q) => q.labels === null).forEach((q) => {
      api.valueCounts(ds.id, q.column).then((vc) => {
        setQs((all) => all.map((x) => (x.key === q.key && x.column === q.column && x.labels === null ? { ...x, ...loadLabels(x, vc) } : x)));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, columnsKey]);

  const labelCols = qs.map((q) => q.column);
  useEffect(() => {
    setInputs((cur) => cur.filter((c) => !labelCols.includes(c)));
    if (ds && !nameTouched) setName(`${ds.name} · ${labelCols.join(", ")}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelCols.join("|"), ds, nameTouched]);

  useEffect(() => {
    if (selModels.length === 0 && models.length && !fromExperiment) setSelModels(models.slice(0, 2).map((m) => m.name));
  }, [models, selModels.length, fromExperiment]);

  const update = (key: number, patch: Partial<QDraft>) => setQs((all) => all.map((q) => (q.key === key ? { ...q, ...patch } : q)));

  // Rows are eligible when any question has a ground truth; approximate with the largest question.
  const eligible = Math.max(0, ...qs.map((q) => (q.labels ?? []).filter((l) => l.include).reduce((a, l) => a + l.count, 0)));
  const sampleN = Math.min(Number(sample) || eligible, eligible);

  const problems = useMemo(() => {
    const p: Problem[] = [];
    if (!ds) p.push({ field: "dataset", msg: "Pick a dataset" });
    if (inputs.length === 0) p.push({ field: "inputs", msg: "Pick at least one input column" });
    if (qs.length === 0) p.push({ field: "questions", msg: "Add a question" });
    qs.forEach((q, i) => {
      const field = `q:${q.key}` as const;
      if (labelCols.indexOf(q.column) !== i) p.push({ field, msg: `“${q.column}” is already used by another question — each question needs its own ground-truth column` });
      if (!q.instructions.trim()) p.push({ field, msg: q.kind === "binary" ? "Write the statement the model should judge" : "Write the question" });
      const included = (q.labels ?? []).filter((l) => l.include);
      if (q.labels && q.kind === "binary" && included.length !== 2) p.push({ field, msg: `Yes/no needs exactly two included labels (${included.length} now)` });
      if (q.labels && q.kind === "binary" && included.length === 2 && !included.some((l) => l.value === q.positive)) p.push({ field, msg: "Pick the positive label" });
      if (q.labels && q.kind === "choice" && (included.length < 2 || included.length > 255)) p.push({ field, msg: `Include 2–255 labels (${included.length} now)` });
    });
    if (selModels.length === 0) p.push({ field: "models", msg: "Pick at least one model" });
    return p;
  }, [ds, inputs.length, qs, labelCols, selModels.length]);
  const problemsFor = (f: Field) => problems.filter((p) => p.field === f).map((p) => p.msg);

  const config: ExperimentConfig | null = useMemo(() => {
    if (!ds || problems.length || qs.some((q) => !q.labels)) return null;
    const ids: string[] = [];
    return {
      name: name.trim() || `${ds.name} · ${labelCols.join(", ")}`,
      dataset_id: ds.id,
      input_columns: inputs,
      context: context.trim() || null,
      tasks: qs.map((q) => {
        const id = slugId(q.column, ids);
        ids.push(id);
        const included = (q.labels ?? []).filter((l) => l.include);
        return {
          id,
          kind: q.kind,
          instructions: q.instructions,
          context: q.context.trim() || null,
          label_column: q.column,
          labels: included.map((l) => ({ value: l.value, description: l.description.trim() || null, aliases: l.aliases.length ? l.aliases : undefined })),
          positive_label: q.kind === "binary" ? q.positive : null,
        };
      }),
      models: selModels,
      sample_size: sampleN < eligible ? sampleN : null,
    };
  }, [ds, problems.length, qs, name, labelCols, inputs, context, selModels, sampleN, eligible]);

  // E1: debounced cost / time estimate. The name doesn't change the estimate.
  const estimateKey = config ? JSON.stringify({ ...config, name: "" }) : "";
  useEffect(() => {
    if (!config) {
      setEstimate(null);
      return;
    }
    setEstimating(true);
    let live = true;
    const t = setTimeout(() => {
      api
        .estimate(config)
        .then((e) => live && setEstimate(e))
        .catch(() => live && setEstimate(null))
        .finally(() => live && setEstimating(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey]);

  const scrollToProblem = () => {
    const first = problems[0];
    if (!first) return;
    const el = document.getElementById(`field-${first.field.replace(":", "-")}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.animate(
      [{ backgroundColor: "transparent" }, { backgroundColor: "var(--warn-soft)" }, { backgroundColor: "transparent" }],
      { duration: 1200, delay: 250, easing: "ease-in-out" },
    );
  };

  const start = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    setConfirmCost(false);
    try {
      const id = await api.experimentCreate(config);
      await api.experimentStart(id);
      toast("Experiment started", "good");
      go({ page: "experiment", id });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const onStart = () => {
    setAttempted(true);
    if (problems.length) {
      scrollToProblem();
      return;
    }
    if (!config) return;
    if ((estimate?.total_cost_usd ?? 0) > 1) setConfirmCost(true);
    else start();
  };

  const applySet = (id: string) => {
    if (!id) return;
    loadSet(id);
  };

  if ((datasets.loading && !datasets.data) || prefillLoading) return <Spinner />;
  const freeColumns = (ds?.columns ?? []).filter((c) => !labelCols.includes(c) && !inputs.includes(c));

  return (
    <>
      <PageHeader
        back={{ label: datasetId ? "Dataset" : "Experiments", onClick: () => (datasetId ? go({ page: "dataset", id: datasetId }) : go({ page: "experiments" })) }}
        title={fromExperiment ? "Duplicate Experiment" : "New Experiment"}
        subtitle="Run rows through several models and score every question against its ground truth."
        actions={
          <Button variant="primary" loading={busy} onClick={onStart} icon={<Play className="size-3.5" />}>
            Start
          </Button>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-10">
        <div>
          <Section title="Data">
            <div id="field-dataset">
              <FormRow label="Dataset:" hint={<FieldProblems msgs={problemsFor("dataset")} />}>
                <Select className="max-w-sm" value={dsId ?? ""} onChange={setDsId} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()} rows)` }))} />
              </FormRow>
            </div>
            <div id="field-inputs">
              <FormRow
                label="Input columns:"
                align="start"
                hint={
                  problemsFor("inputs").length ? <FieldProblems msgs={problemsFor("inputs")} /> : inputs.length > 1 ? "Sent to the model as a JSON object with these keys." : "Sent to the model as plain text."
                }
              >
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {ds?.columns
                    .filter((c) => !labelCols.includes(c))
                    .map((c) => {
                      const on = inputs.includes(c);
                      return (
                        <button
                          key={c}
                          onClick={() => setInputs(on ? inputs.filter((x) => x !== c) : [...inputs, c])}
                          className={cn(
                            "h-[24px] rounded-full px-2.5 font-mono text-[12px] transition-colors duration-150",
                            on ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {c}
                        </button>
                      );
                    })}
                </div>
              </FormRow>
            </div>
            <FormRow label="Shared context:" align="start" hint="Prepended to every question as background.">
              <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Optional, e.g. “Bank transactions from a German personal account, amounts in EUR.”" />
            </FormRow>
          </Section>

          <Section
            title="Questions"
            subtitle="One question per ground-truth column. All are asked in one pass per row and model."
            actions={
              <>
                {(sets.data?.length ?? 0) > 0 && (
                  <Select className="min-w-[11rem]" value="" placeholder="From question set…" onChange={applySet} options={(sets.data ?? []).map((s) => ({ value: s.id, label: `${s.name} · v${s.version}` }))} />
                )}
                {freeColumns.length > 0 && (
                  <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, blankQuestion(guessLabelColumn(freeColumns))])}>
                    Add question
                  </Button>
                )}
              </>
            }
          >
            <div id="field-questions">
              <FieldProblems msgs={problemsFor("questions")} />
            </div>
            <div className="divide-y divide-border">
              {qs.map((q, i) => (
                <QuestionBlock
                  key={q.key}
                  q={q}
                  index={i}
                  problems={problemsFor(`q:${q.key}`)}
                  columns={(ds?.columns ?? []).filter((c) => c === q.column || (!labelCols.includes(c) && !inputs.includes(c)))}
                  onChange={(p) => update(q.key, p)}
                  onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined}
                />
              ))}
            </div>
          </Section>

          <Section title="Models">
            <div id="field-models">
              <ModelPicker value={selModels} onChange={setSelModels} colors={modelColor} />
              <div className="mt-2">
                <FieldProblems msgs={problemsFor("models")} />
              </div>
            </div>
          </Section>

          <Section title="Run">
            <FormRow label="Rows to evaluate:" hint={`A fixed random sample of up to ${eligible.toLocaleString()} labelled rows, so reruns compare like with like.`}>
              <div className="flex max-w-xs gap-1.5">
                <Input type="number" min={1} value={sample} onChange={setSample} />
                <Button onClick={() => setSample(String(eligible))}>All</Button>
              </div>
            </FormRow>
            <FormRow label="Name:">
              <Input
                className="max-w-sm"
                value={name}
                onChange={(v) => {
                  setName(v);
                  setNameTouched(v.trim() !== "");
                }}
              />
            </FormRow>
          </Section>
        </div>

        {/* summary */}
        <aside className="sticky top-6 space-y-3 text-[12.5px]">
          <div className="text-[13px] font-semibold">Summary</div>
          <dl className="space-y-2">
            <Row k="Dataset" v={ds?.name ?? "—"} />
            <Row k="Input" v={<span className="font-mono text-[11.5px]">{inputs.join(" + ") || "—"}</span>} />
            <Row k="Questions" v={qs.length} />
            <Row k="Rows" v={sampleN.toLocaleString()} />
            <Row
              k="Models"
              v={
                <div className="flex flex-wrap justify-end gap-1">
                  {selModels.map((m, i) => (
                    <Badge key={m}>
                      <span className="size-1.5 rounded-full" style={{ background: modelColor(i) }} />
                      {shortModel(m)}
                    </Badge>
                  ))}
                </div>
              }
            />
          </dl>
          <div className="border-t border-border pt-3 text-muted-foreground">
            <b className="text-foreground tnum">{(sampleN * selModels.length).toLocaleString()}</b> requests ·{" "}
            <b className="text-foreground tnum">{(sampleN * selModels.length * qs.length).toLocaleString()}</b> decisions
          </div>
          <EstimateView estimate={estimate} loading={estimating} ready={!!config} />
          {problems.length > 0 && (
            <ul className="space-y-1 border-t border-border pt-3 text-[12px] text-warn">
              {problems.map((p, i) => (
                <li key={i}>
                  <button
                    className="text-left hover:underline"
                    onClick={() => document.getElementById(`field-${p.field.replace(":", "-")}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    • {p.field.startsWith("q:") ? `Question ${qs.findIndex((q) => `q:${q.key}` === p.field) + 1}: ` : ""}
                    {p.msg}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attempted && problems.length > 0 && <div className="text-[11.5px] text-faint">Fix these to start.</div>}
          {error != null && <ErrorNote error={error} />}
        </aside>
      </div>

      <Modal
        open={confirmCost}
        onClose={() => setConfirmCost(false)}
        title="Start a paid run?"
        footer={
          <>
            <Button onClick={() => setConfirmCost(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={start}>
              Start · ≈ {estimate ? usd(estimate.total_cost_usd) : ""}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground">
          This experiment sends about <b className="text-foreground tnum">{estimate?.requests.toLocaleString()}</b> requests to cloud models and should cost roughly{" "}
          <b className="text-foreground tnum">{estimate ? usd(estimate.total_cost_usd) : ""}</b>, taking {estimate ? fmtTime(estimate.total_seconds) : ""}.
        </p>
        {estimate && <EstimateTable estimate={estimate} />}
      </Modal>
    </>
  );
}

function EstimateView({ estimate, loading, ready }: { estimate: Estimate | null; loading: boolean; ready: boolean }) {
  if (!ready) return <div className="text-[12px] text-faint">Cost and time estimate appear once the setup is complete.</div>;
  if (!estimate) return <div className="flex items-center gap-2 text-[12px] text-faint">{loading ? <Spinner delay={0} /> : null} Estimating…</div>;
  return (
    <div className={cn("space-y-1.5 transition-opacity", loading && "opacity-60")}>
      <div className="text-[15px] font-semibold tracking-[-0.01em] tnum">
        ≈ {fmtCost(estimate.total_cost_usd)} <span className="font-normal text-muted-foreground">·</span> {fmtTime(estimate.total_seconds)}
      </div>
      {estimate.total_cost_usd > 1 && <div className="text-[11.5px] text-warn">Above $1 — you'll be asked to confirm.</div>}
      {estimate.per_model.length > 1 && (
        <Disclosure label="Per model">
          <EstimateTable estimate={estimate} />
        </Disclosure>
      )}
    </div>
  );
}

function EstimateTable({ estimate }: { estimate: Estimate }) {
  return (
    <table className="mt-1 w-full text-[12px]">
      <tbody>
        {estimate.per_model.map((m, i) => (
          <tr key={m.model} className="border-t border-border first:border-0">
            <td className="py-1 pr-2">
              <span className="flex items-center gap-1.5 truncate">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: modelColor(i) }} />
                {shortModel(m.model)}
              </span>
            </td>
            <td className="py-1 text-right font-mono text-[11.5px] text-muted-foreground tnum">{fmtCost(m.est_cost_usd)}</td>
            <td className="py-1 pl-2 text-right font-mono text-[11.5px] text-muted-foreground tnum">{fmtTime(m.est_seconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldProblems({ msgs }: { msgs: string[] }) {
  if (!msgs.length) return null;
  return (
    <div className="space-y-0.5">
      {msgs.map((m) => (
        <div key={m} className="flex items-center gap-1.5 text-[12px] text-warn fade-up">
          <AlertCircle className="size-3.5 shrink-0" />
          {m}
        </div>
      ))}
    </div>
  );
}

function QuestionBlock({ q, index, columns, problems, onChange, onRemove }: { q: QDraft; index: number; columns: string[]; problems: string[]; onChange: (p: Partial<QDraft>) => void; onRemove?: () => void }) {
  const included = q.labels?.filter((l) => l.include) ?? [];
  const tooMany = (q.labels?.length ?? 0) > 255;
  const groups = q.labels ? variantGroups(q.labels) : [];
  const regen = (kind: TaskKind, positive: string) => (q.instructionsTouched ? q.instructions : defaultInstructions(q.column, kind, positive));

  const setLabels = (labels: LabelRow[], positive = q.positive) => {
    const pos = labels.some((l) => l.value === positive) ? positive : guessPositive(labels.filter((l) => l.include));
    onChange({ labels, positive: pos, instructions: regen(q.kind, pos) });
  };
  const merge = (from: string, into: string) => {
    const labels = mergeRows(q.labels!, from, into);
    setLabels(labels, q.positive === from ? into : q.positive);
  };
  const mergeGroup = (g: LabelRow[]) => {
    let labels = q.labels!;
    g.slice(1).forEach((r) => (labels = mergeRows(labels, r.value, g[0].value)));
    setLabels(labels, g.some((r) => r.value === q.positive) ? g[0].value : q.positive);
  };
  const unmerge = (value: string, alias: string) => {
    const labels = q.labels!.flatMap((l) => (l.value === value ? [{ ...l, aliases: l.aliases.filter((a) => a !== alias) }, { value: alias, count: 0, include: l.include, description: "", aliases: [] }] : [l]));
    setLabels(labels);
  };

  return (
    <div id={`field-q-${q.key}`} className="py-5 first:pt-0 fade-up">
      <div className="mb-3 flex items-center gap-2">
        <span className="w-5 text-[12px] font-semibold text-faint tnum">{index + 1}</span>
        <span className="text-[12.5px] text-muted-foreground">Ground truth</span>
        <Select
          className="min-w-[10rem]"
          value={q.column}
          onChange={(column) => onChange({ column, labels: null, instructionsTouched: false, seed: q.seed ? { ...q.seed, specs: undefined, positive: undefined } : undefined })}
          options={columns.map((c) => ({ value: c, label: c }))}
        />
        <Segmented
          value={q.kind}
          onChange={(kind) => onChange({ kind, instructions: regen(kind, q.positive) })}
          options={[
            { value: "choice", label: "Pick one" },
            { value: "binary", label: "Yes / No" },
          ]}
        />
        <div className="flex-1" />
        {onRemove && <Button variant="ghost" size="icon" title="Remove question" onClick={onRemove} icon={<Trash2 className="size-3.5" />} />}
      </div>

      <div className="ml-7 space-y-3">
        {problems.length > 0 && <FieldProblems msgs={problems} />}
        <div>
          <Input
            value={q.instructions}
            onChange={(v) => onChange({ instructions: v, instructionsTouched: v.trim() !== "" })}
            placeholder={q.kind === "binary" ? "Statement that is true for the positive label, e.g. This is a recurring payment." : "Question, e.g. Which spending category is this?"}
          />
          <div className="mt-1 text-[11.5px] text-faint">
            {q.kind === "choice" ? "Asked as a pick-one question with one option per label." : `Asked as yes/no; P(yes) ≥ 0.5 predicts “${q.positive || "the positive label"}”.`}
          </div>
        </div>

        <Disclosure label={q.context.trim() ? "Context" : "Add context"} defaultOpen={!!q.context}>
          <Textarea rows={2} value={q.context} onChange={(e) => onChange({ context: e.target.value })} placeholder="Guidance for this question only — definitions, edge cases, coding rules." />
        </Disclosure>

        {tooMany && <ErrorNote>“{q.column}” has more than 255 distinct values — it probably isn't a label column.</ErrorNote>}
        {!q.labels ? (
          <Spinner />
        ) : (
          <div>
            {q.kind === "binary" && included.length >= 2 && (
              <div className="mb-3 flex items-center gap-3">
                <span className="text-[12.5px] text-muted-foreground">Positive label</span>
                <Segmented
                  value={q.positive}
                  onChange={(positive) => onChange({ positive, instructions: regen(q.kind, positive) })}
                  options={included.slice(0, 6).map((l) => ({ value: l.value, label: l.value }))}
                />
                <span className="text-[11.5px] text-faint">“yes” means this label</span>
              </div>
            )}
            {groups.length > 0 && (
              <div className="mb-2 space-y-1">
                {groups.map((g) => (
                  <div key={g[0].value} className="flex items-center gap-2 rounded-[8px] bg-warn-soft px-2.5 py-1.5 text-[12px] fade-up">
                    <Merge className="size-3.5 shrink-0 text-warn" />
                    <span className="min-w-0 flex-1 truncate">
                      {g.map((r, i) => (
                        <span key={r.value}>
                          {i > 0 && <span className="text-faint">, </span>}
                          <span className="rounded bg-background/70 px-1 font-mono text-[11.5px] whitespace-pre">{JSON.stringify(r.value).slice(1, -1)}</span>
                        </span>
                      ))}{" "}
                      <span className="text-muted-foreground">look like the same label</span>
                    </span>
                    <Button size="sm" onClick={() => mergeGroup(g)}>
                      Merge into “{g[0].value}”
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="mb-1 flex justify-between text-[11.5px] text-faint">
              <span>Labels found in “{q.column}”</span>
              <span>
                {included.length} of {q.labels.length} included · {included.reduce((a, l) => a + l.count, 0).toLocaleString()} rows
              </span>
            </div>
            <div className={cn("border-y border-border", q.labels.length > 40 && "max-h-[420px] overflow-auto")}>
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 z-10 bg-background text-[11.5px] text-faint">
                  <tr className="border-b border-border">
                    <th className="w-8 py-1.5" />
                    <th className="py-1.5 text-left font-medium">Value</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Rows</th>
                    <th className="py-1.5 text-left font-medium">What it means (optional, shown to the model)</th>
                    <th className="w-[9.5rem] py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {q.labels.map((l, i) => (
                    <tr key={l.value} className={cn("group border-b border-border/60 last:border-0 transition-opacity", !l.include && "opacity-40")}>
                      <td className="py-1 pl-1">
                        <Checkbox checked={l.include} onChange={(include) => setLabels(q.labels!.map((x, k) => (k === i ? { ...x, include } : x)))} />
                      </td>
                      <td className="max-w-[180px] py-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium" title={l.value}>
                            {l.value}
                          </span>
                          {q.kind === "binary" && q.positive === l.value && <Badge tone="accent">positive</Badge>}
                        </div>
                        {l.aliases.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {l.aliases.map((a) => (
                              <Tooltip key={a} content="Merged spelling — click to split it off again">
                                <button onClick={() => unmerge(l.value, a)} className="rounded bg-sel px-1 font-mono text-[11px] whitespace-pre text-muted-foreground hover:line-through">
                                  {JSON.stringify(a).slice(1, -1)}
                                </button>
                              </Tooltip>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-1 pr-3 text-right font-mono text-[11.5px] text-muted-foreground tnum">{l.count}</td>
                      <td className="py-1">
                        <input
                          value={l.description}
                          disabled={!l.include}
                          onChange={(e) => onChange({ labels: q.labels!.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })}
                          placeholder={`e.g. “${l.value}” means …`}
                          className="h-[24px] w-full rounded-[6px] bg-transparent px-2 text-[12.5px] outline-none placeholder:text-faint focus:bg-sel"
                        />
                      </td>
                      <td className="py-1 pl-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {q.labels!.length > 1 && (
                          <Select
                            className="min-w-[9rem]"
                            value=""
                            placeholder="Merge into…"
                            onChange={(into) => merge(l.value, into)}
                            options={q.labels!.filter((x) => x.value !== l.value).map((x) => ({ value: x.value, label: x.value }))}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{v}</dd>
    </div>
  );
}
