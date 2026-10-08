import { cn } from "@/lib/utils";
import { Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ModelPicker } from "../components/ModelPicker";
import { Badge, Button, Checkbox, Disclosure, ErrorNote, FormRow, Input, PageHeader, Section, Segmented, Select, Spinner, Textarea } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { modelColor, shortModel } from "../lib/format";
import { slugId } from "../lib/questions";
import type { Dataset, ExperimentConfig, TaskKind, ValueCount } from "../lib/types";

interface LabelRow extends ValueCount {
  include: boolean;
  description: string;
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
}

let nextKey = 1;
const defaultInstructions = (col: string, kind: TaskKind) =>
  kind === "binary" ? `This is ${col.replace(/[_-]+/g, " ")}.` : `What is the ${col.replace(/[_-]+/g, " ")} of this text?`;

export function NewExperiment({ datasetId }: { datasetId?: string }) {
  const { go, models, toast } = useApp();
  const datasets = useAsync(() => api.datasets(), []);
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dsId && datasets.data?.length) setDsId(datasets.data[0].id);
  }, [datasets.data, dsId]);

  const newQuestion = (column: string): QDraft => ({ key: nextKey++, column, kind: "choice", instructions: "", instructionsTouched: false, context: "", labels: null, positive: "" });

  // A new dataset resets the setup to one question on the most label-like column.
  useEffect(() => {
    if (!ds) return;
    const l = guessLabelColumn(ds.columns);
    setInputs(guessInputColumns(ds.columns, l));
    setQs([newQuestion(l)]);
  }, [ds]);

  // Load label values whenever a question's column changes.
  const columnsKey = qs.map((q) => `${q.key}:${q.column}`).join("|");
  useEffect(() => {
    if (!ds) return;
    qs.filter((q) => q.labels === null).forEach((q) => {
      api.valueCounts(ds.id, q.column).then((vc) => {
        const rows = vc.filter((v) => v.value !== "").map((v, i) => ({ ...v, include: i < 255, description: "" }));
        const kind: TaskKind = rows.length === 2 ? "binary" : "choice";
        setQs((all) =>
          all.map((x) =>
            x.key === q.key && x.column === q.column
              ? { ...x, labels: rows, kind, positive: rows[0]?.value ?? "", instructions: x.instructionsTouched ? x.instructions : defaultInstructions(q.column, kind) }
              : x,
          ),
        );
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
    if (selModels.length === 0 && models.length) setSelModels(models.slice(0, 2).map((m) => m.name));
  }, [models, selModels.length]);

  const update = (key: number, patch: Partial<QDraft>) => setQs((all) => all.map((q) => (q.key === key ? { ...q, ...patch } : q)));

  // Rows are eligible when any question has a ground truth; approximate with the largest question.
  const eligible = Math.max(0, ...qs.map((q) => (q.labels ?? []).filter((l) => l.include).reduce((a, l) => a + l.count, 0)));
  const sampleN = Math.min(Number(sample) || eligible, eligible);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!ds) p.push("Pick a dataset");
    if (inputs.length === 0) p.push("Pick at least one input column");
    if (qs.length === 0) p.push("Add a question");
    if (new Set(labelCols).size !== labelCols.length) p.push("Each question needs its own ground-truth column");
    qs.forEach((q) => {
      const n = (q.labels ?? []).filter((l) => l.include).length;
      if (q.labels && q.kind === "binary" && n !== 2) p.push(`“${q.column}”: yes/no needs exactly two labels`);
      if (q.labels && q.kind === "choice" && (n < 2 || n > 255)) p.push(`“${q.column}”: include 2–255 labels`);
    });
    if (selModels.length === 0) p.push("Pick at least one model");
    return p;
  }, [ds, inputs.length, qs, labelCols, selModels.length]);

  const submit = async () => {
    if (!ds || problems.length) return;
    setBusy(true);
    setError(null);
    const ids: string[] = [];
    const config: ExperimentConfig = {
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
          labels: included.map((l) => ({ value: l.value, description: l.description.trim() || null })),
          positive_label: q.kind === "binary" ? q.positive : null,
        };
      }),
      models: selModels,
      sample_size: sampleN < eligible ? sampleN : null,
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
  const freeColumns = (ds?.columns ?? []).filter((c) => !labelCols.includes(c) && !inputs.includes(c));

  return (
    <>
      <PageHeader
        back={{ label: datasetId ? "Dataset" : "Experiments", onClick: () => (datasetId ? go({ page: "dataset", id: datasetId }) : go({ page: "experiments" })) }}
        title="New Experiment"
        subtitle="Run rows through several models and score every question against its ground truth."
        actions={
          <Button variant="primary" disabled={problems.length > 0} loading={busy} onClick={submit} icon={<Play className="size-3.5" />}>
            Start
          </Button>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-10">
        <div>
          <Section title="Data">
            <FormRow label="Dataset:">
              <Select className="max-w-sm" value={dsId ?? ""} onChange={setDsId} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()} rows)` }))} />
            </FormRow>
            <FormRow label="Input columns:" align="start" hint={inputs.length > 1 ? "Sent to the model as a JSON object with these keys." : "Sent to the model as plain text."}>
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
            <FormRow label="Shared context:" align="start" hint="Prepended to every question as background.">
              <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Optional, e.g. “Bank transactions from a German personal account, amounts in EUR.”" />
            </FormRow>
          </Section>

          <Section
            title="Questions"
            subtitle="One question per ground-truth column. All are asked in one pass per row and model."
            actions={
              freeColumns.length > 0 && (
                <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, newQuestion(guessLabelColumn(freeColumns))])}>
                  Add question
                </Button>
              )
            }
          >
            <div className="divide-y divide-border">
              {qs.map((q, i) => (
                <QuestionBlock
                  key={q.key}
                  q={q}
                  index={i}
                  columns={(ds?.columns ?? []).filter((c) => c === q.column || (!labelCols.includes(c) && !inputs.includes(c)))}
                  onChange={(p) => update(q.key, p)}
                  onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined}
                />
              ))}
            </div>
          </Section>

          <Section title="Models">
            <ModelPicker value={selModels} onChange={setSelModels} colors={modelColor} />
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
          {problems.length > 0 && (
            <ul className="space-y-1 text-[12px] text-warn">
              {problems.map((p) => (
                <li key={p}>• {p}</li>
              ))}
            </ul>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </aside>
      </div>
    </>
  );
}

function QuestionBlock({ q, index, columns, onChange, onRemove }: { q: QDraft; index: number; columns: string[]; onChange: (p: Partial<QDraft>) => void; onRemove?: () => void }) {
  const included = q.labels?.filter((l) => l.include) ?? [];
  const tooMany = (q.labels?.length ?? 0) > 255;
  return (
    <div className="py-5 first:pt-0 fade-up">
      <div className="mb-3 flex items-center gap-2">
        <span className="w-5 text-[12px] font-semibold text-faint tnum">{index + 1}</span>
        <span className="text-[12.5px] text-muted-foreground">Ground truth</span>
        <Select className="min-w-[10rem]" value={q.column} onChange={(column) => onChange({ column, labels: null, instructionsTouched: false })} options={columns.map((c) => ({ value: c, label: c }))} />
        <Segmented
          value={q.kind}
          onChange={(kind) => onChange({ kind, instructions: q.instructionsTouched ? q.instructions : defaultInstructions(q.column, kind) })}
          options={[
            { value: "choice", label: "Pick one" },
            { value: "binary", label: "Yes / No" },
          ]}
        />
        <div className="flex-1" />
        {onRemove && <Button variant="ghost" size="icon" title="Remove question" onClick={onRemove} icon={<Trash2 className="size-3.5" />} />}
      </div>

      <div className="ml-7 space-y-3">
        <div>
          <Input
            value={q.instructions}
            onChange={(v) => onChange({ instructions: v, instructionsTouched: v.trim() !== "" })}
            placeholder={q.kind === "binary" ? "Statement that is true for the positive label, e.g. This is a recurring payment." : "Question, e.g. Which spending category is this?"}
          />
          <div className="mt-1 text-[11.5px] text-faint">{q.kind === "choice" ? "Asked as a pick-one question with one option per label." : "Asked as yes/no; P(yes) ≥ 0.5 predicts the positive label."}</div>
        </div>

        <Disclosure label={q.context.trim() ? "Context" : "Add context"} defaultOpen={!!q.context}>
          <Textarea rows={2} value={q.context} onChange={(e) => onChange({ context: e.target.value })} placeholder="Guidance for this question only — definitions, edge cases, coding rules." />
        </Disclosure>

        {tooMany && <ErrorNote>“{q.column}” has more than 255 distinct values — it probably isn't a label column.</ErrorNote>}
        {!q.labels ? (
          <Spinner />
        ) : (
          <div>
            <div className="mb-1 flex justify-between text-[11.5px] text-faint">
              <span>Labels found in “{q.column}”</span>
              <span>
                {included.length} of {q.labels.length} included · {included.reduce((a, l) => a + l.count, 0).toLocaleString()} rows
              </span>
            </div>
            <div className="max-h-[300px] overflow-auto border-y border-border">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 z-10 bg-background text-[11px] text-faint">
                  <tr className="border-b border-border">
                    <th className="w-8 py-1.5" />
                    <th className="py-1.5 text-left font-medium">Value</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Rows</th>
                    {q.kind === "binary" && <th className="px-2 py-1.5 text-center font-medium">Positive</th>}
                    <th className="py-1.5 text-left font-medium">What it means (optional, shown to the model)</th>
                  </tr>
                </thead>
                <tbody>
                  {q.labels.map((l, i) => (
                    <tr key={l.value} className={cn("border-b border-border/60 last:border-0 transition-opacity", !l.include && "opacity-40")}>
                      <td className="py-1 pl-1">
                        <Checkbox checked={l.include} onChange={(include) => onChange({ labels: q.labels!.map((x, k) => (k === i ? { ...x, include } : x)) })} />
                      </td>
                      <td className="max-w-[160px] truncate py-1 font-medium" title={l.value}>
                        {l.value}
                      </td>
                      <td className="py-1 pr-3 text-right font-mono text-[11.5px] text-muted-foreground tnum">{l.count}</td>
                      {q.kind === "binary" && (
                        <td className="px-2 py-1 text-center">
                          <input type="radio" disabled={!l.include} checked={q.positive === l.value} onChange={() => onChange({ positive: l.value })} />
                        </td>
                      )}
                      <td className="py-1">
                        <input
                          value={l.description}
                          disabled={!l.include}
                          onChange={(e) => onChange({ labels: q.labels!.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })}
                          placeholder={`e.g. “${l.value}” means …`}
                          className="h-[24px] w-full rounded-[6px] bg-transparent px-2 text-[12.5px] outline-none placeholder:text-faint focus:bg-sel"
                        />
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
