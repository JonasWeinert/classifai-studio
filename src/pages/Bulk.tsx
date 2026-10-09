import { cn } from "@/lib/utils";
import { Download, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelMenu, ModelPicker } from "../components/ModelPicker";
import { QuestionsSection, SharedContext } from "../components/QuestionsSection";
import { EmptyResults, OutdatedBanner, RunHint } from "../components/RunPieces";
import { Button, FormRow, Input, PageHeader, Progress, Section, Segmented, Select, Textarea } from "../components/ui";
import { api, pickSavePath } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { describeError } from "../lib/errors";
import { modelColor, ms, pct, shortModel, usd } from "../lib/format";
import { load, save } from "../lib/persist";
import { headline, useQuestionDraft } from "../lib/questionDraft";
import { useRunShortcut } from "../lib/useRunShortcut";
import type { AnyAnswer } from "../lib/types";

interface BulkRow {
  idx: number;
  input: string;
  answers?: Record<string, AnyAnswer>;
  error?: unknown;
  latency?: number;
  cost?: number;
}

type Source = "paste" | "dataset";

interface Saved {
  source: Source;
  paste: string;
  datasetId: string;
  cols: string[];
  limit: string;
  model: string;
}

// Results survive navigating away and back within a session (they can be large, so not persisted).
let cache: { rows: BulkRow[]; titles: Record<string, string>; ranWith: string | null } | null = null;

const SAMPLE = [
  "I was charged twice this month, please refund the second payment.",
  "The app crashes every time I open the camera.",
  "How do I change the email address on my account?",
  "Cancel my subscription, I found a cheaper alternative.",
].join("\n");

/** Many entries, one model, no ground truth. Same questions and controls as the Playground. */
export function Bulk() {
  const { models, cloudModels, toast, refreshBudget } = useApp();
  const { built, invalid, reset } = useQuestionDraft();
  const saved = useMemo(() => load<Saved | null>("bulk", null), []);
  const [source, setSource] = useState<Source>(saved?.source ?? "paste");
  const [paste, setPaste] = useState(saved?.paste ?? SAMPLE);
  const [datasetId, setDatasetId] = useState(saved?.datasetId ?? "");
  const [cols, setCols] = useState<string[]>(saved?.cols ?? []);
  const [limit, setLimit] = useState(saved?.limit ?? "100");
  const [model, setModel] = useState(saved?.model ?? "");
  const [rows, setRows] = useState<BulkRow[]>(cache?.rows ?? []);
  const [titles, setTitles] = useState<Record<string, string>>(cache?.titles ?? {});
  const [ranWith, setRanWith] = useState<string | null>(cache?.ranWith ?? null);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const datasets = useAsync(() => api.datasets(), []);
  const ds = datasets.data?.find((d) => d.id === datasetId);

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
  useEffect(() => save("bulk", { source, paste, datasetId, cols, limit, model } satisfies Saved), [source, paste, datasetId, cols, limit, model]);
  useEffect(() => {
    cache = { rows, titles, ranWith };
  }, [rows, titles, ranWith]);

  const lines = useMemo(() => paste.split("\n").map((l) => l.trim()).filter(Boolean), [paste]);
  const max = Math.max(1, Math.min(Number(limit) || 100, 10_000));
  const count = source === "paste" ? lines.length : Math.min(max, ds?.row_count ?? 0);
  const canRun = !running && !!model && count > 0 && built.length > 0 && invalid === 0 && (source === "paste" || cols.length > 0);
  const done = rows.filter((r) => r.answers || r.error !== undefined).length;
  const signature = JSON.stringify({ source, paste: source === "paste" ? paste : null, datasetId, cols, max, model, q: built.map((b) => b.q) });
  const outdated = rows.length > 0 && ranWith !== null && ranWith !== signature && !running;

  const run = useCallback(async () => {
    if (!canRun) return;
    let entries: { idx: number; input: string }[];
    if (source === "paste") entries = lines.map((input, idx) => ({ idx, input }));
    else {
      const page = await api.datasetRows(ds!.id, 0, max);
      // Several columns become labelled lines, e.g. "subject: …\nbody: …".
      entries = page.rows.map(([idx, row]) => ({ idx, input: cols.length === 1 ? row[cols[0]] ?? "" : cols.map((c) => `${c}: ${row[c] ?? ""}`).join("\n") }));
    }
    const questions = Object.fromEntries(built.map((b) => [b.id, b.q!]));
    setTitles(Object.fromEntries(built.map((b) => [b.id, b.title])));
    setRows(entries.map((e) => ({ ...e })));
    setRanWith(signature);
    setRunning(true);
    stop.current = false;
    let next = 0;
    const worker = async () => {
      while (!stop.current && next < entries.length) {
        const i = next++;
        try {
          const r = await api.quickClassify({ model, state: entries[i].input, questions });
          setRows((all) => all.map((x, k) => (k === i ? { ...x, answers: r.answers, latency: r.latency_ms, cost: r.cost_usd ?? 0 } : x)));
        } catch (e) {
          setRows((all) => all.map((x, k) => (k === i ? { ...x, error: e } : x)));
        }
      }
    };
    // Cloud models handle parallel requests well; a local model answers fastest with a few in flight.
    await Promise.all(Array.from({ length: model.startsWith("@") ? 6 : 3 }, worker));
    setRunning(false);
    if (model.startsWith("@")) refreshBudget();
    if (stop.current) toast("Stopped — partial results kept");
  }, [built, canRun, cols, ds, lines, max, model, refreshBudget, signature, source, toast]);

  useRunShortcut(run);

  const ids = Object.keys(titles);
  const exportCsv = async () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["row", "input", ...ids.flatMap((id) => [id, `${id}:confidence`])];
    const body = rows.map((r) => [
      String(r.idx + 1),
      r.input,
      ...ids.flatMap((id) => {
        const a = r.answers?.[id];
        if (!a) return [r.error !== undefined ? "error" : "", ""];
        return [headline(a), "confidence" in a ? a.confidence.toFixed(3) : a.type === "noul" ? a.noul.toFixed(3) : ""];
      }),
    ]);
    const path = await pickSavePath("bulk-results.csv");
    if (!path) return;
    await api.saveTextFile(path, [header, ...body].map((line) => line.map(esc).join(",")).join("\n"));
    toast(`Exported ${rows.length} rows`, "good");
  };

  const totalCost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
  const lat = rows.map((r) => r.latency).filter((x): x is number => x !== undefined).sort((a, b) => a - b);

  return (
    <>
      <PageHeader
        title="Bulk"
        subtitle="Many entries, one model. Uses the same questions as the Playground."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3" />} onClick={() => { reset(); setPaste(SAMPLE); setRows([]); setRanWith(null); }}>
              Reset
            </Button>
            <ModelMenu single value={model ? [model] : []} onChange={(v) => setModel(v[0] ?? "")} colors={modelColor} />
            {rows.length > 0 && !running && (
              <Button icon={<Download className="size-3.5" />} onClick={exportCsv}>
                Export CSV
              </Button>
            )}
            {running ? (
              <Button onClick={() => (stop.current = true)} icon={<Square className="size-3" />}>
                Stop · {done} of {rows.length}
              </Button>
            ) : (
              <Button variant="primary" disabled={!canRun} onClick={run}>
                Run {count.toLocaleString()}
                <RunHint />
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] gap-10">
        <div>
          <Section
            title="Input"
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
                <div className="mt-1 text-[11.5px] text-muted-foreground">{lines.length.toLocaleString()} entries · one per line, blank lines are skipped</div>
              </>
            ) : (
              <div className="-ml-2">
                <FormRow label="Dataset:" labelWidth={110}>
                  <Select className="max-w-xs" value={datasetId} onChange={setDatasetId} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()})` }))} placeholder="Choose…" />
                </FormRow>
                <FormRow label="Input columns:" labelWidth={110} align="start">
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {ds?.columns.map((c) => {
                      const on = cols.includes(c);
                      return (
                        <button key={c} onClick={() => setCols(on ? cols.filter((x) => x !== c) : [...cols, c])} className={cn("h-[24px] rounded-full px-2.5 font-mono text-[12px] transition-colors", on ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground hover:text-foreground")}>
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </FormRow>
                <FormRow label="First rows:" labelWidth={110} hint="Runs the first N rows in order. To score models against ground truth, use an experiment.">
                  <Input className="max-w-[7rem]" value={limit} onChange={setLimit} />
                </FormRow>
              </div>
            )}
            <SharedContext />
          </Section>
          <QuestionsSection />
          {!model && (
            <Section title="Model">
              <ModelPicker single value={[]} onChange={(v) => setModel(v[0] ?? "")} colors={modelColor} />
            </Section>
          )}
        </div>

        <div className="self-start">
          {rows.length === 0 ? (
            <EmptyResults hint="Press Run or" />
          ) : (
            <div className="space-y-3">
              {outdated && <OutdatedBanner onRun={run} />}
              <div className={cn("transition-opacity duration-300", outdated && "opacity-45")}>
                <div className="mb-2 flex items-baseline justify-between text-[12px] text-muted-foreground">
                  <span>
                    <b className="font-semibold text-foreground tnum">{done.toLocaleString()}</b> of {rows.length.toLocaleString()} · {shortModel(model)}
                  </span>
                  <span className="tnum">
                    {lat.length ? `median ${ms(lat[Math.floor(lat.length / 2)])}` : ""}
                    {totalCost ? ` · ${usd(totalCost)}` : ""}
                  </span>
                </div>
                {running && <Progress value={done / rows.length} className="mb-3" />}
                <div className="max-h-[calc(100vh-190px)] divide-y divide-border overflow-auto rounded-[14px] bg-card px-4" data-selectable>
                  {rows.map((r) => (
                    <div key={r.idx} className="py-3">
                      <div className="flex gap-2 text-[12.5px]">
                        <span className="w-6 shrink-0 font-mono text-[11px] text-faint tnum">{r.idx + 1}</span>
                        <span className="line-clamp-2 min-w-0" title={r.input}>
                          {r.input}
                        </span>
                      </div>
                      <div className="mt-1.5 ml-8 flex flex-wrap gap-1.5">
                        {r.error !== undefined ? (
                          <span className="text-[12px] text-bad">{describeError(r.error).message}</span>
                        ) : !r.answers ? (
                          <span className="text-[12px] text-faint">…</span>
                        ) : (
                          ids.map((id) => {
                            const a = r.answers![id];
                            return (
                              <span key={id} title={titles[id]} className="inline-flex h-[22px] items-center gap-1 rounded-full bg-background px-2 text-[12px]">
                                <span className="max-w-[9rem] truncate text-muted-foreground">{titles[id]}</span>
                                <span className="font-medium">{a ? headline(a) : "—"}</span>
                                {a && "confidence" in a && <span className="font-mono text-[10.5px] text-faint">{pct(a.confidence, 0)}</span>}
                                {a?.type === "noul" && <span className="font-mono text-[10.5px] text-faint">{a.noul.toFixed(2)}</span>}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
