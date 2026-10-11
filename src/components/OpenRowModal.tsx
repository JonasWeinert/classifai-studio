// "Open in Playground" for a dataset row: choose the input columns and the columns that become
// questions. Each question column's type is inferred from its values and can be overridden.
import { cn } from "@/lib/utils";
import { ArrowRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { guessInputColumns, guessLabelColumn, namedLabelColumn } from "../lib/columns";
import { handoff } from "../lib/handoff";
import { columnQuestion, inferColumn, type Inference } from "../lib/infer";
import { KINDS, type Kind } from "../lib/questionDraft";
import type { Dataset, Row, ValueCount } from "../lib/types";
import { Button, Input, Modal, Select, Spinner } from "./ui";

// Value counts per dataset and column, kept for the session (columns don't change).
const countsCache = new Map<string, Record<string, ValueCount[]>>();

const kindLabel = (k: Kind | null) => (k ? KINDS.find((x) => x.value === k)!.label : "Text");

/** Several columns become labelled lines ("subject: …"), as experiments and Bulk send them. */
export function composeInput(row: Row, cols: string[]) {
  return cols.length === 1 ? row[cols[0]] ?? "" : cols.map((c) => `${c}: ${row[c] ?? ""}`).join("\n");
}

export function OpenRowModal({ dataset, row, onClose }: { dataset: Dataset; row: [number, Row] | null; onClose: () => void }) {
  const { go } = useApp();
  const cols = dataset.columns;
  const [counts, setCounts] = useState<Record<string, ValueCount[]>>(() => countsCache.get(dataset.id) ?? {});
  const [inputCols, setInputCols] = useState<string[]>([]);
  const [qCols, setQCols] = useState<string[] | null>(null);
  const [kinds, setKinds] = useState<Record<string, Kind>>({});
  const [filter, setFilter] = useState("");
  const open = row !== null;

  const inferred = useMemo(() => {
    const out: Record<string, Inference> = {};
    for (const c of cols) if (counts[c]) out[c] = inferColumn(counts[c], dataset.row_count);
    return out;
  }, [cols, counts, dataset.row_count]);

  // Profile every column once per dataset (the counts drive the type hints).
  useEffect(() => {
    if (!open) return;
    const have = countsCache.get(dataset.id) ?? {};
    const missing = cols.slice(0, 60).filter((c) => !have[c]);
    let alive = true;
    missing.forEach((c) =>
      api
        .valueCounts(dataset.id, c)
        .catch(() => [] as ValueCount[])
        .then((vc) => {
          const cur = { ...(countsCache.get(dataset.id) ?? {}), [c]: vc };
          countsCache.set(dataset.id, cur);
          if (alive) setCounts(cur);
        }),
    );
    return () => {
      alive = false;
    };
  }, [open, dataset.id, cols]);

  // Defaults on open: the text-like columns as input, the label-like column as a question.
  useEffect(() => {
    if (!open) return;
    const label = guessLabelColumn(cols);
    setInputCols(guessInputColumns(cols, label));
    setQCols(null);
    setKinds({});
    setFilter("");
  }, [open, cols]);
  // The default question: a column named like a label, else the first whose values look like labels.
  const label = namedLabelColumn(cols) ?? cols.find((c) => !inputCols.includes(c) && (inferred[c]?.kind === "choice" || inferred[c]?.kind === "noul")) ?? guessLabelColumn(cols);
  const questions = qCols ?? (inferred[label]?.kind && !inputCols.includes(label) ? [label] : []);

  const toggleInput = (c: string) => {
    setInputCols((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]));
    if (questions.includes(c)) setQCols(questions.filter((x) => x !== c));
  };
  const toggleQuestion = (c: string) => {
    setQCols(questions.includes(c) ? questions.filter((x) => x !== c) : [...questions, c]);
    if (inputCols.includes(c)) setInputCols(inputCols.filter((x) => x !== c));
  };
  // Selected columns always stay visible while filtering.
  const shownCols = filter.trim() ? cols.filter((c) => c.toLowerCase().includes(filter.trim().toLowerCase()) || inputCols.includes(c) || questions.includes(c)) : cols;
  const kindOf = (c: string): Kind => kinds[c] ?? inferred[c]?.kind ?? "choice";

  const text = row ? composeInput(row[1], inputCols) : "";
  const ready = inputCols.length > 0 && questions.every((c) => inferred[c]);

  const submit = () => {
    if (!row || !ready) return;
    const drafts = questions.map((c) => columnQuestion(c, kindOf(c), inferred[c], counts[c] ?? [], row[1][c]));
    handoff.set({
      text,
      asJson: false,
      questions: drafts.length ? drafts : undefined,
      origin: { datasetId: dataset.id, datasetName: dataset.name, row: row[0], inputCols, rowCount: dataset.row_count },
    });
    onClose();
    go({ page: "quick" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title={row ? `Open row ${row[0] + 1} in the Playground` : ""}
      footer={
        <>
          <span className="mr-auto self-center text-[11.5px] text-faint">
            {questions.length ? `Replaces the Playground's questions with ${questions.length}` : "Keeps the Playground's current questions"}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={submit} icon={<ArrowRight className="size-3.5" />}>
            Open
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {cols.length > 16 && <Input value={filter} onChange={setFilter} placeholder={`Filter ${cols.length} columns`} autoFocus />}
        <div>
          <Heading n={1} title="What the model reads" hint="One or more columns" />
          <Chips cols={shownCols} on={inputCols} onToggle={toggleInput} tone="input" />
          {text && (
            <div className="mt-2 max-h-24 overflow-auto rounded-[10px] bg-card px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground" data-selectable>
              {text}
            </div>
          )}
        </div>

        <div>
          <Heading n={2} title="Columns to ask as questions" hint="Types are inferred from each column's values" />
          <Chips cols={shownCols} on={questions} onToggle={toggleQuestion} tone="question" hints={Object.fromEntries(cols.map((c) => [c, inferred[c] ? kindLabel(inferred[c].kind) : ""]))} />
          {questions.length > 0 && (
            <div className="mt-3 divide-y divide-border rounded-[12px] bg-card">
              {questions.map((c) => {
                const inf = inferred[c];
                const value = row?.[1][c] ?? "";
                return (
                  <div key={c} className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-mono text-[12.5px] font-medium">{c}</span>
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          this row: <b className="font-medium text-foreground">{value || "—"}</b>
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-faint">
                        {!inf ? (
                          <Spinner delay={0} />
                        ) : (
                          <>
                            {!kinds[c] && inf.kind && <Sparkles className="size-3 text-primary" />}
                            <span className={cn(!inf.kind && "text-warn")}>{inf.reason}</span>
                            {inf.values.length > 0 && <span className="truncate">· {inf.values.slice(0, 6).join(", ")}{inf.values.length > 6 ? "…" : ""}</span>}
                          </>
                        )}
                      </div>
                    </div>
                    <Select value={kindOf(c)} onChange={(k) => setKinds({ ...kinds, [c]: k as Kind })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Heading({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className="grid size-[18px] place-items-center rounded-full bg-sel text-[10.5px] font-semibold text-muted-foreground">{n}</span>
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="text-[11.5px] text-faint">{hint}</span>
    </div>
  );
}

function Chips({ cols, on, onToggle, tone, hints }: { cols: string[]; on: string[]; onToggle: (c: string) => void; tone: "input" | "question"; hints?: Record<string, string> }) {
  if (!cols.length) return <div className="text-[12px] text-faint">No column matches.</div>;
  return (
    // Many columns: the chip area scrolls instead of growing the dialog.
    <div className="-mx-1 flex max-h-[7.5rem] flex-wrap gap-1.5 overflow-y-auto px-1 py-0.5">
      {cols.map((c) => {
        const active = on.includes(c);
        return (
          <button
            key={c}
            onClick={() => onToggle(c)}
            aria-pressed={active}
            className={cn(
              "inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 font-mono text-[12px] transition-colors",
              active ? (tone === "input" ? "bg-primary text-primary-foreground" : "bg-foreground text-background") : "bg-sel text-muted-foreground hover:text-foreground",
            )}
          >
            {c}
            {hints?.[c] && <span className={cn("font-sans text-[10.5px]", active ? "opacity-70" : "text-faint")}>{hints[c]}</span>}
          </button>
        );
      })}
    </div>
  );
}
