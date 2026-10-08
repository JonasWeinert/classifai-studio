import clsx from "clsx";
import { ArrowLeft, Check, Play } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ModelPicker } from "../components/ModelPicker";
import { Badge, Button, Card, ErrorNote, Input, Label, PageHeader, Segmented, Select, Spinner } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { modelColor, shortModel } from "../lib/format";
import type { Dataset, ExperimentConfig, TaskKind, ValueCount } from "../lib/types";
import { guessInputColumns, guessLabelColumn } from "./DatasetDetail";

interface LabelRow extends ValueCount {
  include: boolean;
  description: string;
}

export function NewExperiment({ datasetId }: { datasetId?: string }) {
  const { go, models, toast } = useApp();
  const datasets = useAsync(() => api.datasets(), []);
  const [dsId, setDsId] = useState<string | undefined>(datasetId);
  const ds: Dataset | undefined = datasets.data?.find((d) => d.id === dsId);

  const [inputs, setInputs] = useState<string[]>([]);
  const [labelCol, setLabelCol] = useState("");
  const [labels, setLabels] = useState<LabelRow[] | null>(null);
  const [kind, setKind] = useState<TaskKind>("choice");
  const [positive, setPositive] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selModels, setSelModels] = useState<string[]>([]);
  const [sample, setSample] = useState<string>("200");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dsId && datasets.data?.length) setDsId(datasets.data[0].id);
  }, [datasets.data, dsId]);

  // Reset column choices when the dataset changes.
  useEffect(() => {
    if (!ds) return;
    const l = guessLabelColumn(ds.columns);
    setLabelCol(l);
    setInputs(guessInputColumns(ds.columns, l));
    setName(`${ds.name} · ${l}`);
  }, [ds]);

  useEffect(() => {
    if (!ds || !labelCol) return;
    setLabels(null);
    api.valueCounts(ds.id, labelCol).then((vc) => {
      const rows = vc.filter((v) => v.value !== "").map((v, i) => ({ ...v, include: i < 255, description: "" }));
      setLabels(rows);
      const n = rows.filter((r) => r.include).length;
      setKind(n === 2 ? "binary" : "choice");
      setPositive(rows[0]?.value ?? "");
      setInstructions((cur) => cur || defaultInstructions(labelCol));
    });
    setInputs((cur) => cur.filter((c) => c !== labelCol));
  }, [ds, labelCol]);

  useEffect(() => {
    if (selModels.length === 0 && models.length) setSelModels(models.slice(0, 2).map((m) => m.name));
  }, [models, selModels.length]);

  const included = labels?.filter((l) => l.include) ?? [];
  const eligibleRows = included.reduce((a, l) => a + l.count, 0);
  const sampleN = Math.min(Number(sample) || eligibleRows, eligibleRows);
  const tooManyDistinct = (labels?.length ?? 0) > 255;

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!ds) p.push("Pick a dataset");
    if (inputs.length === 0) p.push("Pick at least one input column");
    if (included.length < 2) p.push("Include at least two labels");
    if (kind === "binary" && included.length !== 2) p.push("Yes/no tasks need exactly two labels");
    if (kind === "choice" && included.length > 255) p.push("At most 255 labels");
    if (selModels.length === 0) p.push("Pick at least one model");
    return p;
  }, [ds, inputs.length, included.length, kind, selModels.length]);

  const submit = async () => {
    if (!ds || problems.length) return;
    setBusy(true);
    setError(null);
    const config: ExperimentConfig = {
      name: name.trim() || `${ds.name} · ${labelCol}`,
      dataset_id: ds.id,
      task: {
        kind,
        instructions,
        input_columns: inputs,
        label_column: labelCol,
        labels: included.map((l) => ({ value: l.value, description: l.description.trim() || null })),
        positive_label: kind === "binary" ? positive : null,
      },
      models: selModels,
      sample_size: sampleN < eligibleRows ? sampleN : null,
    };
    try {
      const id = await api.experimentCreate(config);
      await api.experimentStart(id);
      toast("Experiment started", "good");
      go({ page: "experiment", id });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (datasets.loading && !datasets.data) return <Spinner />;

  return (
    <>
      <PageHeader
        back={
          <button onClick={() => (datasetId ? go({ page: "dataset", id: datasetId }) : go({ page: "experiments" }))} className="flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
            <ArrowLeft className="size-3.5" /> Back
          </button>
        }
        title="New experiment"
        subtitle="Run every row through the models you pick and score them against your ground truth."
      />

      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-5">
        <div className="space-y-4">
          <Section n={1} title="Data" done={!!ds && inputs.length > 0 && !!labelCol}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Dataset</Label>
                <Select className="w-full" value={dsId ?? ""} onChange={setDsId} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()} rows)` }))} />
              </div>
              <div>
                <Label hint="the correct answer">Ground truth column</Label>
                <Select className="w-full" value={labelCol} onChange={setLabelCol} options={(ds?.columns ?? []).map((c) => ({ value: c, label: c }))} />
              </div>
            </div>
            <div className="mt-4">
              <Label hint={inputs.length > 1 ? "sent to the model as a JSON object" : "sent as plain text"}>Input columns</Label>
              <div className="flex flex-wrap gap-1.5">
                {ds?.columns
                  .filter((c) => c !== labelCol)
                  .map((c) => {
                    const on = inputs.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() => setInputs(on ? inputs.filter((x) => x !== c) : [...inputs, c])}
                        className={clsx("h-7 rounded-lg border px-2.5 font-mono text-[12px] transition-all", on ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-muted hover:text-fg")}
                      >
                        {c}
                      </button>
                    );
                  })}
              </div>
            </div>
          </Section>

          <Section n={2} title="Task & labels" done={included.length >= 2}>
            <div className="mb-4 flex items-center justify-between gap-4">
              <Segmented
                value={kind}
                onChange={setKind}
                options={[
                  { value: "choice", label: "Pick one label" },
                  { value: "binary", label: "Yes / no" },
                ]}
              />
              <span className="text-[12px] text-faint">{kind === "choice" ? "Ollaya choice question: one option per label" : "Ollaya noul question: P(yes) ≥ 0.5 → positive label"}</span>
            </div>
            <Label hint="what the model is asked">{kind === "binary" ? "Statement that should be true for the positive label" : "Instructions"}</Label>
            <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={kind === "binary" ? "This message is spam." : "What is the sentiment of this review?"} />

            <div className="mt-4">
              <Label hint={labels ? `${included.length} of ${labels.length} included · ${eligibleRows.toLocaleString()} rows` : undefined}>Labels found in “{labelCol}”</Label>
              {tooManyDistinct && <div className="mb-2"><ErrorNote>This column has more than 255 distinct values — it probably isn't a label column.</ErrorNote></div>}
              {!labels ? (
                <Spinner />
              ) : (
                <div className="max-h-[340px] overflow-auto rounded-lg border border-line">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-panel-2 text-[11px] text-faint">
                      <tr>
                        <th className="w-8 px-2 py-1.5" />
                        <th className="px-2 py-1.5 text-left font-medium">Value</th>
                        <th className="px-2 py-1.5 text-right font-medium">Rows</th>
                        {kind === "binary" && <th className="px-2 py-1.5 text-center font-medium">Positive</th>}
                        <th className="px-2 py-1.5 text-left font-medium">Description for the model (optional)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {labels.map((l, i) => (
                        <tr key={l.value} className={clsx("border-t border-line", !l.include && "opacity-45")}>
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" className="accent-[var(--accent)]" checked={l.include} onChange={(e) => setLabels(labels.map((x, k) => (k === i ? { ...x, include: e.target.checked } : x)))} />
                          </td>
                          <td className="max-w-[180px] truncate px-2 py-1 font-medium" title={l.value}>{l.value}</td>
                          <td className="px-2 py-1 text-right font-mono text-[11.5px] text-muted tnum">{l.count}</td>
                          {kind === "binary" && (
                            <td className="px-2 py-1 text-center">
                              <input type="radio" className="accent-[var(--accent)]" disabled={!l.include} checked={positive === l.value} onChange={() => setPositive(l.value)} />
                            </td>
                          )}
                          <td className="px-1 py-1">
                            <input
                              value={l.description}
                              disabled={!l.include}
                              onChange={(e) => setLabels(labels.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))}
                              placeholder={`e.g. “${l.value}” means …`}
                              className="h-7 w-full rounded-md bg-transparent px-2 text-[12.5px] outline-none placeholder:text-faint focus:bg-panel-2"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>

          <Section n={3} title="Models" done={selModels.length > 0}>
            <ModelPicker value={selModels} onChange={setSelModels} colors={modelColor} />
          </Section>

          <Section n={4} title="Run" done>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label hint={`of ${eligibleRows.toLocaleString()} eligible`}>Rows to evaluate</Label>
                <div className="flex gap-1.5">
                  <Input type="number" min={1} value={sample} onChange={(e) => setSample(e.target.value)} />
                  <Button variant="secondary" onClick={() => setSample(String(eligibleRows))}>All</Button>
                </div>
                <div className="mt-1 text-[11.5px] text-faint">A fixed random sample, so reruns compare like with like.</div>
              </div>
              <div>
                <Label>Experiment name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
          </Section>
        </div>

        {/* summary */}
        <Card className="sticky top-10 p-5">
          <div className="text-[13.5px] font-semibold">Summary</div>
          <dl className="mt-3 space-y-2.5 text-[12.5px]">
            <Row k="Dataset" v={ds?.name ?? "—"} />
            <Row k="Input" v={<span className="font-mono">{inputs.join(" + ") || "—"}</span>} />
            <Row k="Ground truth" v={<span className="font-mono">{labelCol || "—"}</span>} />
            <Row k="Task" v={kind === "binary" ? `yes/no · positive = ${positive}` : `${included.length} labels`} />
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
          <div className="mt-4 rounded-lg bg-panel-2 px-3 py-2 text-[12px] text-muted">
            <b className="text-fg tnum">{(sampleN * selModels.length).toLocaleString()}</b> decisions in total
          </div>
          {problems.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12px] text-warn">
              {problems.map((p) => (
                <li key={p}>• {p}</li>
              ))}
            </ul>
          )}
          {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
          <Button variant="primary" size="lg" className="mt-4 w-full" disabled={problems.length > 0} loading={busy} onClick={submit} icon={<Play className="size-4" />}>
            Start experiment
          </Button>
        </Card>
      </div>
    </>
  );
}

function defaultInstructions(col: string) {
  return `What is the ${col.replace(/[_-]+/g, " ")} of this text?`;
}

function Section({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className={clsx("grid size-5.5 place-items-center rounded-full text-[11px] font-semibold", done ? "bg-good-soft text-good" : "bg-panel-2 text-muted")}>
          {done ? <Check className="size-3" strokeWidth={3} /> : n}
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{title}</span>
      </div>
      {children}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{v}</dd>
    </div>
  );
}
