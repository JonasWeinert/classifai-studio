import { cn } from "@/lib/utils";
import { Panes } from "../components/Panes";
import { Database, RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelPicker } from "../components/ModelPicker";
import { composeInput } from "../components/OpenRowModal";
import { QuestionsSection, SharedContext } from "../components/QuestionsSection";
import { RunHint, Step } from "../components/RunPieces";
import { Button, Card, Input, PageHeader, Section, Segmented, Select, Textarea } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { isBulkRunning, startBulk } from "../lib/bulkRunner";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { describeError } from "../lib/errors";
import { modelColor, shortModel } from "../lib/format";
import { load, save } from "../lib/persist";
import { loadQuestionsIntoDraft, useQuestionDraft } from "../lib/questionDraft";
import { useRunShortcut } from "../lib/useRunShortcut";
import type { BulkSetup, Row } from "../lib/types";

type Source = BulkSetup["source"];

const SAMPLE = [
  "I was charged twice this month, please refund the second payment.",
  "The app crashes every time I open the camera.",
  "How do I change the email address on my account?",
  "Cancel my subscription, I found a cheaper alternative.",
].join("\n");

/** Set up a Bulk run: entries, questions (shared with the Playground) and one model. `from` copies a previous run's setup. */
export function NewBulkRun({ from }: { from?: string }) {
  const { toast, refreshBudget, go, models, cloudModels } = useApp();
  const draft = useQuestionDraft();
  const { built: allBuilt, invalid, reset, qs, shared, set } = draft;
  const saved = useMemo(() => load<Partial<BulkSetup> | null>("bulk", null), []);
  const [source, setSource] = useState<Source>(saved?.source ?? "paste");
  const [paste, setPaste] = useState(saved?.paste ?? SAMPLE);
  const [datasetId, setDatasetId] = useState(saved?.datasetId ?? "");
  const [cols, setCols] = useState<string[]>(saved?.cols ?? []);
  const [limit, setLimit] = useState(saved?.limit ?? "100");
  const [model, setModel] = useState(saved?.model ?? "");
  // Free-text questions only for an LLM.
  const built = draft.sendableFor(model);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);
  const datasets = useAsync(() => api.datasets(), []);
  const ds = datasets.data?.find((d) => d.id === datasetId);
  const [preview, setPreview] = useState<Row | null>(null);

  // Duplicating a run: its entries, model and questions.
  useEffect(() => {
    if (!from) return;
    api
      .bulkRun(from)
      .then((r) => {
        const s = r.setup;
        if (!s) return;
        setSource(s.source);
        setPaste(s.paste);
        setDatasetId(s.datasetId);
        setCols(s.cols);
        setLimit(s.limit);
        setModel(s.model);
        setName(`${r.name} (copy)`);
        if (s.questions?.length) loadQuestionsIntoDraft(s.questions, s.context ?? "", s.set ?? null);
      })
      .catch((e) => toast(describeError(e).message, "bad"));
  }, [from, toast]);

  useEffect(() => {
    const all = [...models.map((m) => m.name), ...cloudModels.map((m) => m.id)];
    if ((!model || !all.includes(model)) && all.length) setModel(all[0]);
  }, [model, models, cloudModels]);
  useEffect(() => {
    if (!datasetId && datasets.data?.length) setDatasetId(datasets.data[0].id);
  }, [datasetId, datasets.data]);
  useEffect(() => {
    if (ds && cols.every((c) => !ds.columns.includes(c))) setCols(guessInputColumns(ds.columns, guessLabelColumn(ds.columns)));
  }, [ds, cols]);
  useEffect(() => {
    setPreview(null);
    if (ds) api.datasetRows(ds.id, 0, 1).then((p) => setPreview(p.rows[0]?.[1] ?? null)).catch(() => {});
  }, [ds]);
  useEffect(() => save("bulk", { source, paste, datasetId, cols, limit, model }), [source, paste, datasetId, cols, limit, model]);

  const lines = useMemo(() => paste.split("\n").map((l) => l.trim()).filter(Boolean), [paste]);
  const max = Math.max(1, Math.min(Number(limit) || 100, 10_000));
  const count = source === "paste" ? lines.length : Math.min(max, ds?.row_count ?? 0);
  const inputCols = source === "dataset" ? cols.filter((c) => ds?.columns.includes(c)) : [];
  const autoName = `${set?.name ?? (source === "dataset" ? ds?.name : "Pasted entries") ?? "Bulk"} · ${shortModel(model)}`;
  const problems = [
    count === 0 && (source === "paste" ? "Add at least one entry" : "Choose a dataset"),
    source === "dataset" && ds && inputCols.length === 0 && "Pick at least one column to read",
    allBuilt.length === 0 && "Add a question",
    allBuilt.length > 0 && built.length === 0 && "Only free-text questions — choose an LLM to answer them",
    invalid > 0 && `${invalid} question${invalid === 1 ? " is" : "s are"} incomplete`,
    !model && "Choose a model",
  ].filter((p): p is string => !!p);
  const canRun = !starting && problems.length === 0;

  const start = useCallback(async () => {
    if (!canRun) return;
    if (isBulkRunning()) return toast("Another Bulk run is still going — stop it first", "bad");
    setStarting(true);
    try {
      let entries: { row_idx: number; input?: string }[], inputs: string[], fields: (Record<string, string> | null)[];
      if (source === "paste") {
        entries = lines.map((input, i) => ({ row_idx: i, input }));
        inputs = lines;
        fields = lines.map(() => null);
      } else {
        const page = await api.datasetRows(ds!.id, 0, max);
        entries = page.rows.map(([idx]) => ({ row_idx: idx }));
        inputs = page.rows.map(([, row]) => composeInput(row, inputCols));
        fields = page.rows.map(([, row]) => Object.fromEntries(inputCols.map((c) => [c, row[c] ?? ""])));
      }
      const setup: BulkSetup = {
        source,
        paste: source === "paste" ? paste : "",
        datasetId,
        cols: inputCols,
        limit,
        model,
        questions: qs.map(({ key: _k, expected: _e, ...q }) => q),
        context: shared,
        set,
        sourceColumns: Object.fromEntries(allBuilt.flatMap((b, i) => (b.q && qs[i]?.column ? [[b.id, qs[i].column!]] : []))),
      };
      const id = await startBulk(
        {
          name: name.trim() || autoName,
          model,
          source,
          dataset_id: source === "dataset" ? ds!.id : null,
          columns: inputCols,
          titles: Object.fromEntries(built.map((b) => [b.id, b.title])),
          setup,
          entries,
        },
        inputs,
        fields,
        built.map((b) => ({ id: b.id, title: b.title, q: b.q!, route: b.route })),
        (stopped) => {
          if (model.startsWith("@")) refreshBudget();
          toast(stopped ? "Bulk run stopped — partial results kept" : "Bulk run finished", stopped ? "neutral" : "good");
        },
      );
      go({ page: "bulk-run", id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setStarting(false);
    }
  }, [allBuilt, autoName, built, canRun, datasetId, ds, go, inputCols, limit, lines, max, model, name, paste, qs, refreshBudget, set, shared, source, toast]);

  useRunShortcut(start);

  return (
    <>
      <PageHeader
        back={{ label: "Bulk runs", onClick: () => go({ page: "bulk" }) }}
        title={from ? "Duplicate bulk run" : "New bulk run"}
        subtitle="Ask your questions about many entries with one model."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="size-3" />}
              onClick={() => {
                reset();
                setPaste(SAMPLE);
              }}
            >
              Reset
            </Button>
            <Button variant="primary" disabled={!canRun} loading={starting} onClick={start}>
              Run {count.toLocaleString()}
              <RunHint />
            </Button>
          </>
        }
      />

      <Panes template="minmax(0,1fr) 280px" className="gap-10">
        <div className="min-w-0">
          <Section
            title={<Step n={1}>Entries</Step>}
            subtitle={source === "paste" ? "One entry per line." : "Rows of a dataset; the columns you pick are what the model reads."}
            actions={
              <Segmented
                value={source}
                onChange={setSource}
                options={[
                  { value: "paste", label: "Paste" },
                  { value: "dataset", label: "Dataset" },
                ]}
              />
            }
          >
            {source === "paste" ? (
              <>
                <Textarea rows={7} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="One entry per line" />
                <div className="mt-1 text-[11.5px] text-muted-foreground">{lines.length.toLocaleString()} entries · blank lines are skipped</div>
              </>
            ) : !datasets.data?.length ? (
              <button onClick={() => go({ page: "datasets" })} className="flex w-full items-center gap-2 rounded-[10px] border border-dashed border-border-strong px-3 py-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">
                <Database className="size-3.5" /> No datasets yet — import one first
              </button>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Select className="max-w-xs flex-1" value={datasetId} onChange={setDatasetId} options={datasets.data.map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()} rows)` }))} />
                  <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    first
                    <Input className="w-[5.5rem]" value={limit} onChange={setLimit} />
                    rows{ds && <span className="text-faint">of {ds.row_count.toLocaleString()}</span>}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">Columns the model reads</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ds?.columns.map((c) => {
                      const on = cols.includes(c);
                      return (
                        <button key={c} aria-pressed={on} onClick={() => setCols(on ? cols.filter((x) => x !== c) : [...cols, c])} className={cn("h-[26px] rounded-full px-2.5 font-mono text-[12px] transition-colors", on ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground hover:text-foreground")}>
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {preview && inputCols.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">What the model sees for row 1</div>
                    <div className="max-h-28 overflow-auto rounded-[10px] bg-card px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground" data-selectable>
                      {composeInput(preview, inputCols)}
                    </div>
                  </div>
                )}
              </div>
            )}
            <SharedContext />
          </Section>
          <QuestionsSection step={2} models={model ? [model] : []} />
        </div>

        <aside>
          <Section title={<Step n={3}>Model</Step>}>
            <ModelPicker single value={model ? [model] : []} onChange={(v) => setModel(v[0] ?? "")} colors={modelColor} />
          </Section>
          <Card className="px-4 py-3.5">
            <Input value={name} onChange={setName} placeholder={autoName} />
            <dl className="mt-3 space-y-1.5 text-[12.5px]">
              <Fact label="Entries" value={count.toLocaleString()} />
              <Fact label="Questions" value={allBuilt.length > built.length ? `${built.length} of ${allBuilt.length}` : String(built.length)} hint={allBuilt.length > built.length ? "Free-text questions are skipped by decision models; an LLM answers them" : undefined} />
              <Fact label="Model" value={model ? shortModel(model) : "—"} />
              <Fact label="Requests" value={count ? count.toLocaleString() : "—"} hint="all questions in one pass" />
            </dl>
            {problems.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-border pt-3">
                {problems.map((p) => (
                  <li key={p} className="flex items-center gap-1.5 text-[12px] text-warn">
                    <TriangleAlert className="size-3 shrink-0" /> {p}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="primary" className="mt-3.5 w-full" disabled={!canRun} loading={starting} onClick={start}>
              Run on {count.toLocaleString()} {count === 1 ? "entry" : "entries"}
              <RunHint />
            </Button>
          </Card>
        </aside>
      </Panes>
    </>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium tnum" title={hint}>
        {value}
      </dd>
    </div>
  );
}
