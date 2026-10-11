// Manual labelling: sessions over a dataset with a question set, labelled one entry at a time.
import { Panes } from "../components/Panes";
import { cn } from "@/lib/utils";
import { ArrowLeft, ArrowRight, Check, ChevronsRight, NotebookPen, DatabaseZap, ExternalLink, Flag, Keyboard, Minus, Pencil, Plus, SkipForward, Tag, Trash2, Type } from "lucide-react";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Clamp } from "../components/Clamp";
import { looksLikeMarkdown, Markdown } from "../components/Markdown";
import { QuestionEditor } from "../components/QuestionsSection";
import { Step } from "../components/RunPieces";
import { LabelQuestionCard } from "../components/LabelQuestionCard";
import { SelectionToContext } from "../components/SelectionToContext";
import { entrySentences, selectedPassage, selectSentences } from "../lib/sentenceSelect";
import { Badge, Button, Card, Checkbox, compareValues, Empty, ErrorNote, Input, Modal, PageHeader, Progress, SearchField, Section, Segmented, Select, SortTh, Spinner, Switch, Textarea, Tooltip, type SortState } from "../components/ui";
import { shortColumnName } from "../lib/answers";
import { api, errorMessage, fileSrc, openExternal } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { describeError } from "../lib/errors";
import { ago } from "../lib/format";
import { applicable, cellOf, choiceIndex, isAnswered, isImageUrl, isUrl, labelQuestions, questionColor, tint, titlesOf, type LabelQuestion } from "../lib/labelling";
import { load, save } from "../lib/persist";
import { blank, EXAMPLE, isComplete, newKey, type QDraft } from "../lib/questionDraft";
import type { LabelMark, LabelSession, LabelSessionSummary, LabelSnippet, LabelValue, QuestionSetPayload, Row } from "../lib/types";

// ---- list -----------------------------------------------------------------------------------------

type Key = "name" | "dataset" | "progress" | "updated";

export function LabelSessions() {
  const { go, toast } = useApp();
  const sessions = useAsync(() => api.labelSessions(), []);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<Key>>({ key: "updated", desc: true });
  const [deleting, setDeleting] = useState<LabelSessionSummary | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (sessions.data ?? []).filter((s) => !q || [s.name, s.dataset_name, ...Object.values(s.titles)].some((x) => x.toLowerCase().includes(q)));
    const v = (s: LabelSessionSummary, k: Key) => (k === "name" ? s.name : k === "dataset" ? s.dataset_name : k === "progress" ? s.done / Math.max(1, s.total) : s.updated_at);
    if (sort) out.sort((a, b) => compareValues(v(a, sort.key), v(b, sort.key)) * (sort.desc ? -1 : 1));
    return out;
  }, [sessions.data, search, sort]);

  return (
    <>
      <PageHeader
        title="Manual labelling"
        subtitle="Answer your questions yourself, one entry at a time. Every answer is saved as you go."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "label-new" })}>
            New labelling session
          </Button>
        }
      />
      {sessions.error && <ErrorNote>{sessions.error}</ErrorNote>}
      {sessions.loading && !sessions.data && <Spinner />}
      {sessions.data?.length === 0 && (
        <Empty icon={<Tag />} title="No labelling sessions yet" action={<Button variant="primary" onClick={() => go({ page: "label-new" })}>Start labelling</Button>}>
          Pick a dataset and a question set, then label entries with a click or a key press. Save the labels as a dataset to use them as ground truth.
        </Empty>
      )}
      {!!sessions.data?.length && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <SearchField value={search} onChange={setSearch} placeholder="Search sessions" />
            <span className="ml-auto text-[12px] text-faint tnum">{search ? `${rows.length} of ${sessions.data.length}` : `${sessions.data.length} sessions`}</span>
          </div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-[11.5px] text-faint">
              <tr>
                <SortTh k="name" sort={sort} onSort={setSort}>Session</SortTh>
                <SortTh k="dataset" sort={sort} onSort={setSort} className="px-3">Dataset</SortTh>
                <th className="px-3 py-2.5 text-right font-medium">Questions</th>
                <SortTh k="progress" sort={sort} onSort={setSort} className="px-3">Progress</SortTh>
                <th className="px-3 py-2.5 text-left font-medium">Saved as</th>
                <SortTh k="updated" sort={sort} onSort={setSort} align="right">Last worked on</SortTh>
                <th className="w-[1%]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => go({ page: "label", id: s.id })} className="group cursor-pointer border-t border-border hover:bg-sel/50">
                  <td className="py-2.5 font-medium">
                    <span className="block max-w-[16rem] truncate">{s.name}</span>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    <span className="block max-w-[12rem] truncate">{s.dataset_name}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tnum">{Object.keys(s.titles).length}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Progress value={s.done / Math.max(1, s.total)} className="w-24" color={s.done === s.total ? "var(--good)" : undefined} />
                      <span className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground tnum">
                        {s.done}/{s.total}
                      </span>
                      {s.flagged > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] text-warn">
                          <Flag className="size-3" />
                          {s.flagged}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {s.saved_dataset_id && s.saved_dataset_name ? (
                      <button onClick={() => go({ page: "dataset", id: s.saved_dataset_id! })} className="inline-flex max-w-[12rem] items-center gap-1 text-[12px] text-good hover:underline">
                        <Check className="size-3 shrink-0" /> <span className="truncate">{s.saved_dataset_name}</span>
                      </button>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right text-[12px] text-faint">{ago(s.updated_at)}</td>
                  <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <Tooltip content="Delete">
                        <Button size="icon" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(s)} />
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete labelling session?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                try {
                  await api.labelSessionDelete(deleting!.id);
                  toast(`Deleted ${deleting!.name}`);
                  sessions.reload();
                } catch (e) {
                  toast(errorMessage(e), "bad");
                }
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground">
          The {deleting?.done} labelled entries of “{deleting?.name}” are removed.{deleting?.saved_dataset_name ? ` The dataset “${deleting.saved_dataset_name}” saved from it stays.` : ""}
        </p>
      </Modal>
    </>
  );
}

// ---- setup ----------------------------------------------------------------------------------------

interface Draft {
  datasetId: string;
  columns: string[];
  source: "set" | "new";
  setId: string;
  newName: string;
  newSetId: string | null;
  newQs: Omit<QDraft, "key">[];
  context: string;
  order: "sequential" | "random";
  limit: string;
}

/** Choose a dataset, the columns to read and a question set (or write one, saved automatically). */
export function NewLabelSession() {
  const { go, toast } = useApp();
  const datasets = useAsync(() => api.datasets(), []);
  const sets = useAsync(() => api.questionSets(), []);
  const saved = useMemo(() => load<Partial<Draft>>("label-setup", {}), []);
  const [datasetId, setDatasetId] = useState(saved.datasetId ?? "");
  const [columns, setColumns] = useState<string[]>(saved.columns ?? []);
  const [source, setSource] = useState<Draft["source"]>(saved.source ?? "set");
  const [setId, setSetId] = useState(saved.setId ?? "");
  const [newName, setNewName] = useState(saved.newName ?? "");
  const [newSetId, setNewSetId] = useState<string | null>(saved.newSetId ?? null);
  const [qs, setQs] = useState<QDraft[]>(() => (saved.newQs?.length ? saved.newQs.map((q) => ({ ...q, key: newKey() })) : [blank()]));
  const [context, setContext] = useState(saved.context ?? "");
  const [order, setOrder] = useState<Draft["order"]>(saved.order ?? "sequential");
  const [limit, setLimit] = useState(saved.limit ?? "");
  const [name, setName] = useState("");
  const [autosave, setAutosave] = useState<"idle" | "saving" | "saved">("idle");
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<Row | null>(null);
  const set = useAsync(() => (setId ? api.questionSet(setId) : Promise.resolve(null)), [setId]);

  const ds = datasets.data?.find((d) => d.id === datasetId);
  useEffect(() => {
    if (!datasetId && datasets.data?.length) setDatasetId(datasets.data[0].id);
  }, [datasetId, datasets.data]);
  useEffect(() => {
    if (ds && columns.every((c) => !ds.columns.includes(c))) setColumns(guessInputColumns(ds.columns, guessLabelColumn(ds.columns)));
  }, [ds, columns]);
  useEffect(() => {
    if (!setId && sets.data?.length) setSetId(sets.data[0].id);
    if (sets.data && !sets.data.length && source === "set") setSource("new");
  }, [setId, sets.data, source]);
  useEffect(() => {
    setPreview(null);
    if (ds) api.datasetRows(ds.id, 0, 1).then((p) => setPreview(p.rows[0]?.[1] ?? null)).catch(() => {});
  }, [ds]);

  const strip = (q: QDraft) => {
    const { key: _k, column: _c, expected: _e, ...rest } = q;
    return rest;
  };
  useEffect(
    () => save("label-setup", { datasetId, columns, source, setId, newName, newSetId, newQs: qs.map(strip), context, order, limit } satisfies Draft),
    [datasetId, columns, source, setId, newName, newSetId, qs, context, order, limit],
  );

  // A question set written here saves itself (as one version while drafting).
  const newValid = qs.length > 0 && qs.every((q) => isComplete(q, context));
  const newPayload: QuestionSetPayload = useMemo(() => ({ context, questions: qs.map(strip) }), [qs, context]);
  useEffect(() => {
    if (source !== "new" || !newName.trim() || !newValid) return;
    setAutosave("saving");
    const t = setTimeout(async () => {
      try {
        const s = await api.questionSetSave({ id: newSetId, name: newName.trim(), payload: newPayload, amend: true });
        setNewSetId(s.id);
        setAutosave("saved");
      } catch {
        setAutosave("idle");
      }
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, newName, newPayload, newValid]);

  const payload = source === "set" ? set.data?.payload ?? null : newPayload;
  const questions = labelQuestions(payload);
  const count = ds ? Math.min(ds.row_count, Number(limit) > 0 ? Math.floor(Number(limit)) : ds.row_count) : 0;
  const shown = columns.filter((c) => ds?.columns.includes(c));
  const autoName = `${source === "set" ? set.data?.name ?? "Labels" : newName.trim() || "Labels"} · ${ds?.name ?? ""}`;
  const problems = [
    !ds && "Choose a dataset",
    ds && shown.length === 0 && "Pick at least one column to show",
    source === "set" && !setId && "Choose a question set",
    source === "new" && !newName.trim() && "Name the question set",
    source === "new" && !newValid && "Finish the questions",
    questions.length === 0 && source === "set" && setId && "This set has no questions",
  ].filter((p): p is string => !!p);

  const start = async () => {
    if (problems.length || !ds || !payload) return;
    setStarting(true);
    try {
      let setRef: { id: string; version: number } | null = set.data ? { id: set.data.id, version: set.data.version } : null;
      if (source === "new") {
        const s = await api.questionSetSave({ id: newSetId, name: newName.trim(), payload: newPayload, amend: true });
        setRef = { id: s.id, version: s.version };
        // The next session drafted here starts a fresh set.
        setNewSetId(null);
      }
      const s = await api.labelSessionCreate({
        name: name.trim() || autoName,
        dataset_id: ds.id,
        columns: shown,
        question_set_id: setRef?.id ?? null,
        question_set_version: setRef?.version ?? null,
        questions: payload,
        titles: titlesOf(questions),
        order,
        limit: Number(limit) > 0 ? Math.floor(Number(limit)) : null,
        seed: Math.floor(Math.random() * 1e9),
      });
      go({ page: "label", id: s.id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ label: "Manual labelling", onClick: () => go({ page: "labelling" }) }}
        title="New labelling session"
        subtitle="Choose what to read and what to answer; then label entry by entry."
        actions={
          <Button variant="primary" disabled={problems.length > 0} loading={starting} onClick={start}>
            Start labelling
          </Button>
        }
      />
      <Panes template="minmax(0,1fr) 280px" className="gap-10">
        <div className="min-w-0">
          <Section title={<Step n={1}>Dataset</Step>} subtitle="The columns you pick are shown for every entry.">
            <div className="space-y-4">
              <Select className="max-w-sm" value={datasetId} onChange={setDatasetId} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.row_count.toLocaleString()} rows)` }))} placeholder="Choose a dataset…" />
              {ds && (
                <div className="flex flex-wrap gap-1.5">
                  {ds.columns.map((c) => {
                    const on = columns.includes(c);
                    return (
                      <button key={c} aria-pressed={on} onClick={() => setColumns(on ? columns.filter((x) => x !== c) : ds.columns.filter((x) => x === c || columns.includes(x)))} className={cn("h-[26px] rounded-full px-2.5 font-mono text-[12px] transition-colors", on ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground hover:text-foreground")}>
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
              {preview && shown.length > 0 && (
                <div className="rounded-[12px] bg-card px-4 py-3">
                  <div className="mb-2 text-[11px] font-medium text-faint">Row 1, as you'll see it</div>
                  <EntryFields row={preview} columns={shown} size={13} />
                </div>
              )}
            </div>
          </Section>

          <Section
            title={<Step n={2}>Questions</Step>}
            actions={
              <Segmented
                value={source}
                onChange={setSource}
                options={[
                  { value: "set", label: "Saved set" },
                  { value: "new", label: "Write new" },
                ]}
              />
            }
          >
            {source === "set" ? (
              <div className="space-y-3">
                <Select className="max-w-sm" value={setId} onChange={setSetId} options={(sets.data ?? []).map((s) => ({ value: s.id, label: `${s.name} · v${s.version} · ${s.question_count} questions` }))} placeholder="Choose a question set…" />
                {payload?.context?.trim() && (
                  <Clamp className="rounded-[12px] border border-dashed border-border-strong px-3.5 py-2 text-[12px] leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground">Context: </span>
                    {payload.context}
                  </Clamp>
                )}
                {questions.length > 0 && (
                  <ol className="divide-y divide-border rounded-[12px] bg-card">
                    {questions.map((q, i) => (
                      <li key={q.id} className="px-3.5 py-2 text-[12.5px]">
                        <div className="flex items-baseline gap-3">
                          <span className="w-4 shrink-0 text-faint tnum">{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate font-medium">{q.title}</span>
                          <span className="max-w-[45%] truncate text-[11.5px] text-muted-foreground">{q.choices.map((c) => c.label).join(" · ")}</span>
                        </div>
                        {q.q.context.trim() && <Clamp className="mt-0.5 pl-7 text-[11.5px] leading-snug text-muted-foreground">{q.q.context}</Clamp>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input value={newName} onChange={setNewName} placeholder="Question set name, e.g. Abstract screening" />
                  </div>
                  <span className="w-44 shrink-0 text-right text-[11.5px] whitespace-nowrap text-faint">{!newName.trim() ? "" : autosave === "saving" ? "Saving…" : autosave === "saved" ? "✓ Saved to question sets" : !newValid ? "Saves when complete" : ""}</span>
                </div>
                <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context every question should know (optional)" />
                <div className="divide-y divide-border">
                  {qs.map((q, i) => (
                    <QuestionEditor key={q.key} q={q} index={i} invalid={!isComplete(q, context)} routing={{ qs, setQs }} onChange={(p) => setQs(qs.map((x) => (x.key === q.key ? { ...x, ...p } : x)))} onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined} />
                  ))}
                  <div className="flex gap-1 pt-3">
                    <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, blank()])}>
                      Add question
                    </Button>
                    {qs.length === 1 && !qs[0].text && (
                      <Button variant="ghost" size="sm" onClick={() => setQs(EXAMPLE())}>
                        Start from an example
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Section>
        </div>

        <aside>
          <Section title={<Step n={3}>Session</Step>}>
            <div className="space-y-3">
              <Input value={name} onChange={setName} placeholder={autoName} />
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">Order</div>
                <Segmented
                  value={order}
                  onChange={setOrder}
                  options={[
                    { value: "sequential", label: "In order" },
                    { value: "random", label: "Shuffled" },
                  ]}
                />
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">Entries</div>
                <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <div className="w-24">
                    <Input value={limit} onChange={setLimit} placeholder="all" />
                  </div>
                  of {ds?.row_count.toLocaleString() ?? "—"}
                </div>
                <div className="mt-1 text-[11.5px] text-faint">{order === "random" ? "A random sample, shown shuffled." : "The first rows, in dataset order."}</div>
              </div>
            </div>
          </Section>
          <Card className="px-4 py-3.5">
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span className="text-muted-foreground">To label</span>
              <span className="font-medium tnum">
                {count.toLocaleString()} × {questions.length} question{questions.length === 1 ? "" : "s"}
              </span>
            </div>
            {problems.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-border pt-3 text-[12px] text-warn">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <Button variant="primary" className="mt-3.5 w-full" disabled={problems.length > 0} loading={starting} onClick={start}>
              Start labelling
            </Button>
          </Card>
        </aside>
      </Panes>
    </>
  );
}

// ---- workspace ------------------------------------------------------------------------------------

/** The entry's fields: labelled, readable, images and links shown as such. `marks`: passages marked as context (stronger for the active question). */
/** Indices of `qs` grouped into cards: a question, then its follow-ups (and theirs) that follow it. */
function groupFollowUps(qs: LabelQuestion[]): number[][] {
  const groups: number[][] = [];
  qs.forEach((q, i) => {
    const last = groups[groups.length - 1];
    if (last && q.route && last.some((j) => qs[j].id === q.route!.parent)) last.push(i);
    else groups.push([i]);
  });
  return groups;
}

/** An answered question folded to one line above its follow-up; click to change the answer. */
const AnsweredSummary = forwardRef<HTMLButtonElement, { n: number; title: string; answer: string; color: string; onClick: () => void }>(function AnsweredSummary({ n, title, answer, color, onClick }, ref) {
  return (
    <button ref={ref} onClick={onClick} title="Change this answer" className="group/sum flex w-full items-center gap-2 rounded-[11px] bg-card/70 px-3 py-2 text-left transition-colors hover:bg-card">
      <span className="grid size-5 shrink-0 place-items-center rounded-full text-white" style={{ background: color }}>
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
        <span className="tnum text-faint">{n + 1} · </span>
        {title}
      </span>
      <span className="max-w-[45%] shrink-0 truncate rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: tint(color, 16), color }}>
        {answer}
      </span>
      <span className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover/sum:opacity-100">Change</span>
    </button>
  );
});

/**
 * Text with passages marked as context highlighted. A passage is found by its text (whitespace
 * may differ, since selections collapse it); one that no longer occurs is just not shown.
 */
type Mark = LabelSnippet & { active: boolean; color: string; title: string };

function MarkedText({ text, marks }: { text: string; marks: Mark[] }) {
  const spans: { start: number; end: number; m: Mark }[] = [];
  for (const m of marks) {
    const pattern = m.text.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const hit = pattern ? new RegExp(pattern).exec(text) : null;
    if (hit) spans.push({ start: hit.index, end: hit.index + hit[0].length, m });
  }
  if (!spans.length) return <>{text}</>;
  spans.sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((sp, i) => {
    const start = Math.max(sp.start, at);
    if (start >= sp.end) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark
        key={i}
        title={`Context for “${sp.m.title}”`}
        className="rounded-[3px] text-inherit transition-[background-color,box-shadow] duration-200 [box-decoration-break:clone]"
        style={{ background: tint(sp.m.color, sp.m.active ? 30 : 13), boxShadow: sp.m.active ? `inset 0 -2px 0 ${sp.m.color}` : undefined }}
      >
        {text.slice(start, sp.end)}
      </mark>,
    );
    at = sp.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function EntryFields({ row, columns, size, marks = [] }: { row: Row; columns: string[]; size: number; marks?: Mark[] }) {
  return (
    <dl className="space-y-4">
      {columns.map((c) => {
        const v = row[c] ?? "";
        return (
          <div key={c}>
            {columns.length > 1 && <dt className="mb-1 font-mono text-[11px] font-medium tracking-wide text-faint uppercase">{c}</dt>}
            <dd data-column={c} className="leading-relaxed break-words whitespace-pre-wrap text-foreground" style={{ fontSize: size }}>
              {!v.trim() ? (
                <span className="text-[13px] text-faint italic">empty</span>
              ) : isImageUrl(v) ? (
                <img src={fileSrc(v)} alt={c} className="max-h-[28rem] max-w-full rounded-[10px] bg-background object-contain" />
              ) : isUrl(v) ? (
                <button onClick={() => openExternal(v)} className="inline-flex items-center gap-1 text-primary hover:underline">
                  {v} <ExternalLink className="size-3" />
                </button>
              ) : looksLikeMarkdown(v) ? (
                <div className="whitespace-normal">
                  <Markdown text={v} />
                </div>
              ) : (
                <MarkedText text={v} marks={marks.filter((m) => m.column === c)} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

type Status = "done" | "partial" | "skipped" | "todo";

/** Widths the questions pane steps through when fitting. Wider panes fit more question columns
 *  (see `cardWidth`) and wider cards put options two-up. */
const Q_WIDTHS = [340, 380, 440, 480, 520, 600, 680, 760, 860, 960, 1150];
const COL_GAP = 10;

/** The narrowest a question card stays comfortable, by kind: yes/no buttons are compact, a scale
 *  needs room per level, option lists and written answers need more. */
function cardWidth(q: LabelQuestion): number {
  switch (q.q.kind) {
    case "noul":
      return 220;
    case "score":
      return Math.max(240, q.choices.length * 64);
    case "text":
      return 280;
    case "number":
      return 230;
    default: {
      // Option lists: as wide as the longest option label needs (one option per line).
      const longest = Math.max(0, ...q.choices.map((c) => c.label.length));
      return Math.max(220, Math.min(320, 150 + longest * 7));
    }
  }
}
const Q_MIN_DRAG = 300;
/** The entry pane never gets narrower than this. */
const MIN_ENTRY = 460;

const SHORTCUTS: [string, string][] = [
  ["1 – 9", "Pick an option of the active question"],
  ["Y / N", "Yes or No"],
  ["↑ ↓  or  Tab", "Move between questions"],
  ["↵  or  →", "Next entry"],
  ["←", "Previous entry"],
  ["U", "Next entry still to do"],
  ["S", "Skip this entry"],
  ["F", "Flag for later"],
  ["E", "Write a note on this entry (Esc to leave)"],
  ["C", "Show the full context of the active question (Esc closes it)"],
  ["⌫", "Clear the active answer"],
  ["hold ⌥", "Select a sentence of the entry (the first, or the last one you had)"],
  ["⌥ ←  →", "Previous / next sentence"],
  ["⌥ ⇧ ←  →", "Extend the selection by a sentence"],
  ["↵  with text selected", "Add the selection as context for the active question"],
  ["?", "Show these shortcuts"],
];

export function LabelWorkspace({ id }: { id: string }) {
  const { go, toast } = useApp();
  const [s, setS] = useState<LabelSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pos, setPos] = useState(0);
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [auto, setAuto] = useState(() => load<boolean>("label-auto-advance", true));
  const [size, setSize] = useState(() => load<number>("label-font-size", 15));
  const [help, setHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when the app (not the user) moves to the next open question, so a free-text one gets the cursor.
  const autoJump = useRef(false);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const entryRef = useRef<HTMLDivElement>(null);
  // The question whose full context and option descriptions are open in a dialog.
  const [details, setDetails] = useState<string | null>(null);
  // Layout: both panes fill the window's height; the questions pane takes the narrowest width at
  // which its questions fit without scrolling (option lists go two-up when wide enough), unless
  // the person dragged the divider.
  const gridRef = useRef<HTMLDivElement>(null);
  const qPaneRef = useRef<HTMLDivElement>(null);
  const [paneH, setPaneH] = useState<number | null>(null);
  const [gridW, setGridW] = useState(0);
  const [autoW, setAutoW] = useState(Q_WIDTHS[0]);
  const [manualW, setManualW] = useState<number | null>(() => load<number | null>("label-split", null));
  const [dragging, setDragging] = useState(false);
  const lastFit = useRef("");
  /** Content height of the questions pane at each width tried in the current fit. */
  const fitHeights = useRef<Record<number, number>>({});
  const fitSettled = useRef(false);
  useEffect(() => save("label-split", manualW), [manualW]);

  useEffect(() => {
    api
      .labelSession(id)
      .then((x) => {
        setS(x);
        setPos(Math.min(x.position, Math.max(0, x.row_order.length - 1)));
      })
      .catch(setError);
  }, [id]);
  useEffect(() => save("label-auto-advance", auto), [auto]);
  useEffect(() => save("label-font-size", size), [size]);

  // Every question of the session; `questions` below are the ones that apply to this entry (follow-ups appear once triggered).
  const allQuestions = useMemo(() => labelQuestions(s?.questions), [s?.questions]);
  const order = s?.row_order ?? [];
  const rowIdx = order[pos];
  const answers = useMemo(() => (s && rowIdx !== undefined ? s.answers[rowIdx] : undefined) ?? {}, [s, rowIdx]);
  const questions = useMemo(() => applicable(allQuestions, answers), [allQuestions, answers]);
  const colorOf = (q: LabelQuestion) => questionColor(Math.max(0, allQuestions.indexOf(q)));
  const mark: LabelMark = (s && rowIdx !== undefined ? s.marks[rowIdx] : undefined) ?? { skipped: false, flagged: false, note: null };
  const evidence: Record<string, LabelSnippet[]> = (s && rowIdx !== undefined ? s.evidence?.[rowIdx] : undefined) ?? {};

  /** Replace the context passages of one question on this entry. */
  const setEvidence = useCallback(
    (qid: string, list: LabelSnippet[]) => {
      if (!s || rowIdx === undefined) return;
      const row = { ...(s.evidence?.[rowIdx] ?? {}) };
      if (list.length) row[qid] = list;
      else delete row[qid];
      setS({ ...s, evidence: { ...(s.evidence ?? {}), [rowIdx]: row } });
      api.labelEvidenceSet(id, rowIdx, qid, list).catch((e) => toast(`Not saved: ${describeError(e).message}`, "bad"));
    },
    [id, rowIdx, s, toast],
  );
  const addEvidence = useCallback(
    (snip: LabelSnippet) => {
      const q = questions[active];
      if (!q) return;
      const list = evidence[q.id] ?? [];
      if (list.some((x) => x.column === snip.column && x.text === snip.text)) return;
      setEvidence(q.id, [...list, snip]);
    },
    [active, evidence, questions, setEvidence],
  );

  // Keyboard sentence selection: where it is per entry (anchor and moving end, as sentence indices).
  const sentence = useRef<{ row: number; anchor: number; focus: number } | null>(null);
  /** `step` 0 selects the remembered (or first) sentence; ±1 moves, or with `extend` grows the selection. */
  const moveSentence = useCallback(
    (step: number, extend: boolean) => {
      const root = entryRef.current;
      if (!root || rowIdx === undefined) return;
      const list = entrySentences(root);
      if (!list.length) return;
      const clamp = (i: number) => Math.max(0, Math.min(list.length - 1, i));
      const cur = sentence.current?.row === rowIdx ? sentence.current : { row: rowIdx, anchor: 0, focus: 0 };
      let focus = clamp(cur.focus + step);
      if (extend) {
        // A selection stays inside one field: don't run past the anchor's field.
        const anchor = clamp(cur.anchor);
        while (list[focus].field !== list[anchor].field) focus += focus > anchor ? -1 : 1;
      }
      const next = extend ? { ...cur, anchor: clamp(cur.anchor), focus } : { row: rowIdx, anchor: focus, focus };
      sentence.current = next;
      selectSentences(list, next.anchor, next.focus);
    },
    [rowIdx],
  );

  const statusOf = useCallback(
    (r: number): Status => {
      if (!s) return "todo";
      const a = s.answers[r] ?? {};
      const qs = applicable(allQuestions, a);
      const n = qs.filter((q) => isAnswered(a[q.id])).length;
      if (n === qs.length && n > 0) return "done";
      if (s.marks[r]?.skipped) return "skipped";
      return n > 0 ? "partial" : "todo";
    },
    [s, allQuestions],
  );
  const done = order.filter((r) => statusOf(r) === "done").length;

  // Rows around the current entry, fetched ahead.
  useEffect(() => {
    if (!s) return;
    const want = order.slice(Math.max(0, pos - 3), pos + 12).filter((r) => !(r in rows));
    if (!want.length) return;
    api.datasetRowsAt(s.dataset_id, want).then((got) => setRows((prev) => ({ ...prev, ...Object.fromEntries(got) }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.dataset_id, pos, order]);

  // Remember where the person is.
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(() => api.labelPositionSet(id, pos).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [id, pos, s]);

  const firstOpen = useCallback((a: Record<string, LabelValue>) => Math.max(0, applicable(allQuestions, a).findIndex((q) => !isAnswered(a[q.id]))), [allQuestions]);
  const goTo = useCallback(
    (p: number) => {
      if (!s) return;
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      const next = Math.max(0, Math.min(order.length - 1, p));
      setPos(next);
      setActive(firstOpen(s.answers[order[next]] ?? {}));
      document.getElementById("main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
    },
    [firstOpen, order, s],
  );
  const nextTodo = useCallback(() => {
    for (let k = 1; k <= order.length; k++) {
      const p = (pos + k) % order.length;
      const st = statusOf(order[p]);
      if (st === "todo" || st === "partial") return goTo(p);
    }
    toast("Every entry is labelled or skipped", "good");
  }, [goTo, order, pos, statusOf, toast]);

  const setAnswer = useCallback(
    (qi: number, v: LabelValue | null, advance = true) => {
      if (!s || rowIdx === undefined) return;
      const q = questions[qi];
      const nextAnswers = { ...answers };
      if (v === null) delete nextAnswers[q.id];
      else nextAnswers[q.id] = v;
      setS({ ...s, answers: { ...s.answers, [rowIdx]: nextAnswers } });
      api.labelAnswerSet(id, rowIdx, q.id, v).catch((e) => toast(`Not saved: ${describeError(e).message}`, "bad"));
      if (mark.skipped && v !== null) {
        const m = { ...mark, skipped: false };
        setS((cur) => (cur ? { ...cur, answers: { ...cur.answers, [rowIdx]: nextAnswers }, marks: { ...cur.marks, [rowIdx]: m } } : cur));
        api.labelMarkSet(id, rowIdx, m).catch(() => {});
      }
      if (!advance || v === null) return;
      // Move to the next open question; when the entry is complete, on to the next entry.
      // The questions that apply now: answering may have brought in (or ruled out) follow-ups.
      const next = applicable(allQuestions, nextAnswers);
      // Prefer the next open question below this one (e.g. a follow-up it just brought in), then any open one.
      const here = next.findIndex((x) => x.id === q.id);
      const below = next.findIndex((x, k) => k > here && !isAnswered(nextAnswers[x.id]));
      const open = below >= 0 ? below : next.findIndex((x) => x.id !== q.id && !isAnswered(nextAnswers[x.id]));
      if (open >= 0) {
        autoJump.current = true;
        setActive(open);
      } else if (auto && pos < order.length - 1) {
        if (advanceTimer.current) clearTimeout(advanceTimer.current);
        advanceTimer.current = setTimeout(() => {
          autoJump.current = true;
          goTo(pos + 1);
        }, 320);
      }
    },
    [allQuestions, answers, auto, goTo, id, mark, order.length, pos, questions, rowIdx, s, toast],
  );

  const setMark = useCallback(
    (patch: Partial<LabelMark>) => {
      if (!s || rowIdx === undefined) return;
      const m = { ...mark, ...patch };
      setS({ ...s, marks: { ...s.marks, [rowIdx]: m } });
      api.labelMarkSet(id, rowIdx, m).catch((e) => toast(`Not saved: ${describeError(e).message}`, "bad"));
    },
    [id, mark, rowIdx, s, toast],
  );

  // Keyboard: the active question takes option keys; arrows move; S/F/U act on the entry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!s || e.metaKey || e.ctrlKey || editing || saving) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.isContentEditable)) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (document.querySelector("[role=dialog]")) return;
      // ⌥: sentence selection in the entry (hold to select, arrows to move, ⇧ to extend).
      if (e.key === "Alt" || (e.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))) {
        e.preventDefault();
        if (e.key === "Alt" && e.repeat) return;
        moveSentence(e.key === "Alt" ? 0 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1, e.shiftKey);
        return;
      }
      if (e.altKey) return;
      // ↵ with text selected in the entry: add it as context for the active question.
      if (e.key === "Enter" && !e.shiftKey) {
        const passage = selectedPassage(entryRef.current);
        if (passage) {
          e.preventDefault();
          addEvidence(passage);
          window.getSelection()?.removeAllRanges();
          return;
        }
      }
      const q = questions[active];
      const key = e.key;
      let handled = true;
      if (key === "ArrowDown" || (key === "Tab" && !e.shiftKey)) setActive((a) => Math.min(questions.length - 1, a + 1));
      else if (key === "ArrowUp" || (key === "Tab" && e.shiftKey)) setActive((a) => Math.max(0, a - 1));
      else if (key === "ArrowRight") goTo(pos + 1);
      else if (key === "ArrowLeft") goTo(pos - 1);
      else if (key === "Enter" && q?.q.kind === "text" && !isAnswered(answers[q.id])) cards.current[active]?.querySelector("textarea")?.focus();
      else if (key === "Enter") {
        const open = questions.findIndex((x, k) => k > active && !isAnswered(answers[x.id]));
        if (q && (q.q.kind === "multi" || q.q.kind === "rank") && open >= 0) setActive(open);
        else goTo(pos + 1);
      } else if (key === "Backspace" || key === "Delete") q && setAnswer(active, null);
      else if (key === "?") setHelp(true);
      else if (q?.q.kind === "noul" && (key === "y" || key === "n")) setAnswer(active, key === "y");
      else if (key === "s") {
        setMark({ skipped: !mark.skipped });
        if (!mark.skipped) goTo(pos + 1);
      } else if (key === "f") setMark({ flagged: !mark.flagged });
      else if (key === "e") {
        noteRef.current?.focus();
        noteRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else if (key === "c" && q && (q.q.context.trim() || q.choices.some((c) => c.description))) setDetails(q.id);
      else if (key === "u") nextTodo();
      else {
        const i = choiceIndex(key);
        if (q && i !== null && i < q.choices.length) {
          const c = q.choices[i];
          const cur = answers[q.id];
          const list = Array.isArray(cur) ? cur : [];
          switch (q.q.kind) {
            case "noul":
              setAnswer(active, c.value === "yes");
              break;
            case "number":
              setAnswer(active, Number(c.value));
              break;
            case "multi":
            case "rank":
              setAnswer(active, list.includes(c.value) ? list.filter((x) => x !== c.value) : [...list, c.value], false);
              break;
            default:
              setAnswer(active, cur === c.value ? null : c.value);
          }
        } else handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, addEvidence, answers, editing, goTo, mark, moveSentence, nextTodo, pos, questions, s, saving, setAnswer, setMark]);

  // Keep the active question in view.
  useEffect(() => {
    cards.current[active]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  // After an automatic jump to an unanswered free-text question, put the cursor in it so typing can start.
  useEffect(() => {
    if (!autoJump.current) return;
    autoJump.current = false;
    const q = questions[active];
    if (q?.q.kind !== "text" || isAnswered(answers[q.id])) return;
    // After paint, so the entry's cards are in place; not cancelled, since the flag is already used up.
    requestAnimationFrame(() => cards.current[active]?.querySelector("textarea")?.focus({ preventScroll: true }));
  }, [active, pos, answers, questions]);

  const ready = !!s && order.length > 0;
  const complete0 = ready && done === order.length;
  // Height from the grid's top to the window's bottom; width of the grid, for the split.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const main = document.getElementById("main-scroll");
      const top = el.getBoundingClientRect().top + (main?.scrollTop ?? 0) - (main?.getBoundingClientRect().top ?? 0);
      const viewport = main?.clientHeight ?? window.innerHeight;
      const page = el.closest(".page-in");
      const pad = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
      setPaneH(Math.max(420, Math.floor(viewport - top - pad)));
      setGridW(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ready, complete0]);

  const maxQ = Math.max(Q_WIDTHS[0], Math.min(gridW * 0.55, gridW - MIN_ENTRY));
  const qW = Math.round(Math.min(manualW ?? autoW, maxQ));
  // Columns: two when both fit the widest-needing question (yes/no cards are compact, long option
  // lists are not), else one.
  const minCard = Math.max(0, ...questions.map(cardWidth));
  const qCols = Math.max(1, Math.min(2, questions.length, Math.floor((qW - 8 + COL_GAP) / (minCard + COL_GAP))));
  // Fit: start narrow for each new entry / layout, then widen step by step while the questions overflow.
  // These updates happen before paint, so the widths in between are never seen.
  const fitKey = `${rowIdx}|${questions.map((q) => q.id).join()}|${paneH}|${gridW}|${JSON.stringify(answers).length}`;
  useLayoutEffect(() => {
    if (manualW !== null || !ready) return;
    if (lastFit.current !== fitKey) {
      lastFit.current = fitKey;
      fitHeights.current = {};
      fitSettled.current = false;
      if (autoW !== Q_WIDTHS[0]) return setAutoW(Q_WIDTHS[0]);
    }
    const el = qPaneRef.current;
    if (!el || fitSettled.current) return;
    fitHeights.current[autoW] = el.scrollHeight;
    if (el.scrollHeight <= el.clientHeight + 1) return void (fitSettled.current = true);
    const next = Q_WIDTHS.find((w) => w > autoW && w <= maxQ);
    if (next) return setAutoW(next);
    // Even the widest step scrolls: take the narrowest width that is nearly as short, so width
    // that buys little height stays with the entry.
    fitSettled.current = true;
    const tried = Object.entries(fitHeights.current).map(([w, h]) => [Number(w), h] as const);
    const best = Math.min(...tried.map(([, h]) => h));
    const pick = tried.filter(([, h]) => h <= best * 1.08).sort((a, b) => a[0] - b[0])[0]?.[0];
    if (pick !== undefined && pick !== autoW) setAutoW(pick);
  });

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = qW;
    setDragging(true);
    const move = (ev: PointerEvent) => setManualW(Math.round(Math.max(Q_MIN_DRAG, Math.min(startW - (ev.clientX - startX), gridW - MIN_ENTRY))));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (error) return <ErrorNote error={error} />;
  if (!s) return <Spinner />;
  if (!order.length) return <Empty icon={<Tag />} title="This session has no entries" />;

  const row = rows[rowIdx];
  const complete = done === order.length;
  const rename = async () => {
    const n = renaming?.trim();
    setRenaming(null);
    if (!n || n === s.name) return;
    await api.labelSessionUpdate(id, { name: n });
    setS({ ...s, name: n });
  };

  return (
    <>
      <PageHeader
        back={{ label: "Manual labelling", onClick: () => go({ page: "labelling" }) }}
        title={
          renaming !== null ? (
            <form className="-my-1 max-w-sm font-normal" onSubmit={(e) => (e.preventDefault(), rename())} onBlur={rename} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}>
              <Input autoFocus value={renaming} onChange={setRenaming} />
            </form>
          ) : (
            <button onClick={() => setRenaming(s.name)} className="group/title inline-flex min-w-0 items-center gap-1.5 text-left">
              <span className="truncate">{s.name}</span>
              <Pencil className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover/title:opacity-100" />
            </button>
          )
        }
        subtitle={
          <span className="tnum">
            {s.dataset_name} · <b className="font-medium text-foreground">{done}</b> of {order.length} labelled
          </span>
        }
        actions={
          <>
            <Tooltip content="Keyboard shortcuts (?)" side="bottom">
              <Button variant="ghost" size="icon" icon={<Keyboard className="size-4" />} onClick={() => setHelp(true)} />
            </Tooltip>
            <Button variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
              Questions
            </Button>
            {s.saved_dataset_id && s.saved_dataset_name ? (
              <Button icon={<Check className="size-3.5" />} onClick={() => go({ page: "dataset", id: s.saved_dataset_id! })}>
                {s.saved_dataset_name}
              </Button>
            ) : null}
            <Button variant={complete ? "primary" : "secondary"} icon={<DatabaseZap className="size-3.5" />} disabled={done + order.filter((r) => statusOf(r) === "partial").length === 0} onClick={() => setSaving(true)}>
              {s.saved_dataset_id ? "Save again" : "Save as dataset"}
            </Button>
          </>
        }
      />

      <ProgressStrip order={order} pos={pos} statusOf={statusOf} flagged={(r) => !!s.marks[r]?.flagged} onJump={goTo} />

      {complete && (
        <div className="mb-4 flex items-center gap-3 rounded-[12px] bg-good-soft px-4 py-2.5 text-[12.5px] text-good fade-up">
          <Check className="size-4" />
          <span className="flex-1">All {order.length} entries are labelled. Save them as a dataset to use as ground truth in evaluations.</span>
          {!s.saved_dataset_id && (
            <Button size="sm" variant="primary" onClick={() => setSaving(true)}>
              Save as dataset
            </Button>
          )}
        </div>
      )}

      <div
        ref={gridRef}
        data-fill-height
        className={cn("grid", dragging && "cursor-col-resize select-none")}
        style={{ gridTemplateColumns: `minmax(0,1fr) 20px ${qW}px`, height: paneH ?? undefined }}
      >
        {/* The entry */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2.5">
              <span className="text-[12.5px] font-semibold tnum">
                Entry {pos + 1} <span className="font-normal text-faint">of {order.length}</span>
              </span>
              <span className="font-mono text-[11px] text-faint">row {rowIdx + 1}</span>
              {mark.skipped && <Badge>Skipped</Badge>}
              {mark.flagged && <Badge tone="warn">Flagged</Badge>}
              <div className="ml-auto flex items-center gap-0.5">
                <Tooltip content="Smaller text">
                  <Button size="icon" variant="ghost" icon={<Minus className="size-3" />} disabled={size <= 12} onClick={() => setSize(size - 1)} />
                </Tooltip>
                <Type className="size-3.5 text-faint" />
                <Tooltip content="Larger text">
                  <Button size="icon" variant="ghost" icon={<Plus className="size-3" />} disabled={size >= 22} onClick={() => setSize(size + 1)} />
                </Tooltip>
                <span className="mx-1 h-4 w-px bg-border" />
                <Tooltip content={mark.flagged ? "Unflag (F)" : "Flag for later (F)"}>
                  <Button size="icon" variant="ghost" icon={<Flag className={cn("size-3.5", mark.flagged && "fill-warn text-warn")} />} onClick={() => setMark({ flagged: !mark.flagged })} />
                </Tooltip>
              </div>
            </div>
            <div key={rowIdx} ref={entryRef} className="label-entry min-h-0 flex-1 overflow-y-auto px-5 py-5 fade-up" data-selectable style={{ "--q": questions[active] ? colorOf(questions[active]) : "var(--primary)" } as React.CSSProperties}>
              {row ? (
                <EntryFields
                  row={row}
                  columns={s.columns}
                  size={size}
                  marks={questions.flatMap((q, i) => (evidence[q.id] ?? []).map((x) => ({ ...x, active: i === active, color: colorOf(q), title: q.title })))}
                />
              ) : (
                <div className="h-28 rounded-[8px] shimmer" />
              )}
            </div>
            <SelectionToContext container={entryRef} target={questions[active]?.title ?? null} color={questions[active] ? colorOf(questions[active]) : "var(--primary)"} onAdd={addEvidence} />
          </Card>

          <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
            <Button icon={<ArrowLeft className="size-3.5" />} disabled={pos === 0} onClick={() => goTo(pos - 1)}>
              Previous
            </Button>
            <Tooltip content="Skip this entry (S)">
              <Button
                variant="ghost"
                icon={<SkipForward className="size-3.5" />}
                onClick={() => {
                  setMark({ skipped: !mark.skipped });
                  if (!mark.skipped) goTo(pos + 1);
                }}
              >
                {mark.skipped ? "Unskip" : "Skip"}
              </Button>
            </Tooltip>
            <div className="flex-1" />
            <Switch checked={auto} onChange={setAuto} label="Auto-advance" />
            <Tooltip content="Next entry still to do (U)">
              <Button variant="ghost" icon={<ChevronsRight className="size-3.5" />} onClick={nextTodo}>
                Next to do
              </Button>
            </Tooltip>
            <Button variant="primary" disabled={pos >= order.length - 1} onClick={() => goTo(pos + 1)}>
              Next <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Divider: drag to resize, double-click to fit automatically */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panes"
          title={manualW === null ? "Drag to resize" : "Drag to resize · double-click to fit automatically"}
          onPointerDown={startDrag}
          onDoubleClick={() => setManualW(null)}
          className="group relative cursor-col-resize touch-none"
        >
          <div className={cn("absolute inset-y-3 left-1/2 w-px -translate-x-1/2 transition-colors", dragging ? "bg-primary" : "bg-transparent group-hover:bg-border-strong")} />
          <div className={cn("absolute top-1/2 left-1/2 h-9 w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,opacity]", dragging ? "bg-primary opacity-100" : "bg-border-strong opacity-50 group-hover:opacity-100")} />
        </div>

        {/* The questions */}
        <div ref={qPaneRef} className="@container -m-1 min-h-0 space-y-2.5 overflow-y-auto p-1 pb-2">
          {s.questions.context?.trim() && (
            <Clamp className="rounded-[12px] border border-dashed border-border-strong px-3 py-2 text-[12px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground">Context: </span>
              {s.questions.context}
            </Clamp>
          )}
          {/* Up to two columns, read left to right; cards in a row share their height. */}
          <div className="grid" style={{ gridTemplateColumns: `repeat(${qCols}, minmax(0, 1fr))`, gap: COL_GAP }}>
          {groupFollowUps(questions).map((group) => (
            <div key={questions[group[0]].id} className={cn(group.length > 1 && "space-y-1.5 rounded-[16px] bg-card/40 p-1.5")}>
              {group.map((i) => {
                const q = questions[i];
                const n = allQuestions.indexOf(q);
                // An answered question with a follow-up showing folds to one line (until it is the active one again).
                if (i !== active && isAnswered(answers[q.id]) && group.some((j) => questions[j].route?.parent === q.id)) {
                  return (
                    <AnsweredSummary
                      key={q.id}
                      ref={(el) => {
                        cards.current[i] = el;
                      }}
                      n={n}
                      title={q.title}
                      answer={cellOf(q, answers[q.id])}
                      color={colorOf(q)}
                      onClick={() => setActive(i)}
                    />
                  );
                }
                const parent = q.route ? allQuestions.find((x) => x.id === q.route!.parent) : undefined;
                return (
                  <LabelQuestionCard
                    key={q.id}
                    ref={(el) => {
                      cards.current[i] = el;
                    }}
                    lq={q}
                    index={n}
                    value={answers[q.id]}
                    active={i === active}
                    onShowDetails={() => setDetails(q.id)}
                    onActivate={() => setActive(i)}
                    onChange={(v) => setAnswer(i, v, q.q.kind !== "multi" && q.q.kind !== "rank" && q.q.kind !== "number" && q.q.kind !== "text")}
                    snippets={evidence[q.id] ?? []}
                    color={colorOf(q)}
                    followUpOf={parent ? `#${allQuestions.indexOf(parent) + 1} → ${cellOf(parent, answers[parent.id])}` : undefined}
                    contextHint={!Object.values(s.evidence ?? {}).some((r) => Object.keys(r).length)}
                    onRemoveSnippet={(k) => setEvidence(q.id, (evidence[q.id] ?? []).filter((_, j) => j !== k))}
                  />
                );
              })}
            </div>
          ))}
          </div>
          <NoteField key={rowIdx} ref={noteRef} value={mark.note ?? ""} onSave={(note) => setMark({ note: note || null })} />
          <div className="px-1 pt-1 text-[11.5px] text-faint">
            Keys <kbd className="font-mono">1–9</kbd> answer the highlighted question · <kbd className="font-mono">↵</kbd> next entry ·{" "}
            <button className="underline-offset-2 hover:underline" onClick={() => setHelp(true)}>
              all shortcuts
            </button>
          </div>
        </div>
      </div>

      <QuestionDetails q={allQuestions.find((x) => x.id === details) ?? null} onClose={() => setDetails(null)} />
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" width={420}>
        <dl className="space-y-1.5">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 text-[12.5px]">
              <dt className="text-muted-foreground">{v}</dt>
              <dd className="font-mono text-[12px]">{k}</dd>
            </div>
          ))}
        </dl>
      </Modal>
      {saving && <SaveLabelsModal s={s} questions={allQuestions} statusOf={statusOf} onClose={() => setSaving(false)} onSaved={(d) => setS({ ...s, saved_dataset_id: d.id, saved_dataset_name: d.name })} />}
      {editing && (
        <EditQuestionsModal
          s={s}
          onClose={() => setEditing(false)}
          onSaved={(payload, titles) => {
            setS({ ...s, questions: payload, titles });
            setActive(0);
          }}
        />
      )}
    </>
  );
}

/** Every entry as a sliver: done, partly done, skipped, flagged; click to jump. */
function ProgressStrip({ order, pos, statusOf, flagged, onJump }: { order: number[]; pos: number; statusOf: (r: number) => Status; flagged: (r: number) => boolean; onJump: (p: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const done = order.filter((r) => statusOf(r) === "done").length;
  if (order.length > 400) {
    return (
      <div className="mb-4 flex items-center gap-3">
        <Progress value={done / order.length} className="flex-1" color="var(--good)" />
        <span className="font-mono text-[11.5px] text-muted-foreground tnum">{Math.round((done / order.length) * 100)}%</span>
      </div>
    );
  }
  const color: Record<Status, string> = { done: "bg-good", partial: "bg-warn/70", skipped: "bg-faint/50", todo: "bg-sel" };
  return (
    <div className="relative mb-4">
      <div className="flex h-2.5 gap-px overflow-hidden rounded-full" onMouseLeave={() => setHover(null)}>
        {order.map((r, p) => (
          <button
            key={p}
            aria-label={`Entry ${p + 1}`}
            onMouseEnter={() => setHover(p)}
            onClick={() => onJump(p)}
            className={cn("min-w-[2px] flex-1 transition-[transform,opacity]", flagged(r) ? "bg-warn" : color[statusOf(r)], p === pos && "!bg-primary", hover === p && "opacity-70")}
          />
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-[5px] bg-foreground px-1.5 py-0.5 text-[10.5px] text-background tnum" style={{ left: `${((hover + 0.5) / order.length) * 100}%` }}>
          {hover + 1} · {flagged(order[hover]) ? "flagged" : statusOf(order[hover]) === "todo" ? "to do" : statusOf(order[hover])}
        </div>
      )}
    </div>
  );
}

/** An optional note per entry, saved as you type; it goes into the saved dataset with the labels. */
const NoteField = forwardRef<HTMLTextAreaElement, { value: string; onSave: (v: string) => void }>(function NoteField({ value, onSave }, ref) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  const saved = useRef(value);
  const commit = (next: string) => {
    if (next.trim() === saved.current.trim()) return;
    saved.current = next;
    onSave(next.trim());
  };
  useEffect(() => {
    const t = setTimeout(() => commit(v), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <label className={cn("block rounded-[14px] p-3 transition-[background-color,box-shadow] duration-200", focused ? "bg-card shadow-[0_0_0_2px_var(--primary)]" : "bg-card/60 hover:bg-card")}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn("grid size-5 place-items-center rounded-full", v.trim() ? "bg-good text-white" : "bg-sel text-muted-foreground")}>
          {v.trim() ? <Check className="size-3" strokeWidth={3} /> : <NotebookPen className="size-3" />}
        </span>
        <span className="text-[13.5px] font-semibold">Note</span>
        <span className="text-[11.5px] text-faint">optional{!focused && " · E"}</span>
      </div>
      <textarea
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        rows={Math.min(6, Math.max(2, v.split("\n").length))}
        placeholder="Anything worth remembering about this entry — saved automatically"
        className="w-full resize-none rounded-[8px] bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-faint"
      />
    </label>
  );
});

function SaveLabelsModal({ s, questions, statusOf, onClose, onSaved }: { s: LabelSession; questions: LabelQuestion[]; statusOf: (r: number) => Status; onClose: () => void; onSaved: (d: { id: string; name: string }) => void }) {
  const { toast, go } = useApp();
  const [name, setName] = useState(`${s.name} labels`);
  const [names, setNames] = useState<Record<string, string>>(() => {
    const taken: string[] = [];
    return Object.fromEntries(
      questions.map((q) => {
        let n = shortColumnName(q.title, q.id);
        for (let k = 2; taken.includes(n); k++) n = `${n}_${k}`;
        taken.push(n);
        return [q.id, n];
      }),
    );
  });
  const [onlyDone, setOnlyDone] = useState(true);
  const [withNotes, setWithNotes] = useState(Object.values(s.marks).some((m) => m.note || m.flagged));
  const [busy, setBusy] = useState(false);
  const rows = s.row_order.filter((r) => (onlyDone ? statusOf(r) === "done" : statusOf(r) === "done" || statusOf(r) === "partial"));
  // Context passages go wide: per question as many columns as the most passages any saved row has.
  const contextCounts = Object.fromEntries(questions.map((q) => [q.id, Math.max(0, ...rows.map((r) => s.evidence?.[r]?.[q.id]?.length ?? 0))]));
  const hasContext = Object.values(contextCounts).some((n) => n > 0);
  const [withContext, setWithContext] = useState(true);
  const contextCols = (q: LabelQuestion) => Array.from({ length: withContext ? contextCounts[q.id] : 0 }, (_, k) => `${names[q.id]?.trim() || q.id}_context_${k + 1}`);
  const contextTotal = questions.reduce((n, q) => n + contextCounts[q.id], 0);
  const firstWithContext = questions.find((q) => contextCounts[q.id] > 0);
  const contextExample = firstWithContext ? `${names[firstWithContext.id]?.trim() || firstWithContext.id}_context_1` : "";
  const cols = [...questions.map((q) => names[q.id]?.trim() || q.id), ...questions.flatMap(contextCols), ...(withNotes ? ["label_note", "label_flagged"] : [])];
  const duplicate = new Set(cols).size !== cols.length;

  const submit = async () => {
    setBusy(true);
    try {
      const d = await api.datasetDerive(
        s.dataset_id,
        name,
        rows.map((r) => {
          const a = s.answers[r] ?? {};
          // Follow-ups that don't apply to this entry stay empty (an answer kept from before a change doesn't count).
          const applies = new Set(applicable(questions, a).map((q) => q.id));
          const cells: Row = Object.fromEntries(questions.map((q) => [names[q.id]?.trim() || q.id, applies.has(q.id) ? cellOf(q, a[q.id]) : ""]));
          for (const q of questions) contextCols(q).forEach((c, k) => (cells[c] = s.evidence?.[r]?.[q.id]?.[k]?.text ?? ""));
          if (withNotes) Object.assign(cells, { label_note: s.marks[r]?.note ?? "", label_flagged: s.marks[r]?.flagged ? "yes" : "" });
          return [r, cells];
        }),
        `Manual labels · ${s.name}`,
      );
      await api.labelSessionSetSaved(s.id, d.id);
      onSaved(d);
      onClose();
      toast(`Saved “${d.name}” · ${d.row_count.toLocaleString()} rows`, "good");
      go({ page: "dataset", id: d.id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      title="Save labels as a dataset"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || rows.length === 0 || duplicate} onClick={submit}>
            Save {rows.length.toLocaleString()} rows
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input value={name} onChange={setName} placeholder="Dataset name" autoFocus />
        <p className="rounded-[12px] bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
          The labelled rows link to <b className="font-medium text-foreground">{s.dataset_name}</b>; only your answers are stored. Use the new columns as ground truth in an evaluation.
        </p>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">Columns</div>
          <div className="space-y-1.5">
            {questions.map((q) => (
              <div key={q.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,13rem)] items-center gap-3">
                <span className="truncate text-[12.5px]" title={q.title}>
                  {q.title}
                </span>
                <Input mono value={names[q.id] ?? ""} onChange={(v) => setNames({ ...names, [q.id]: v })} />
              </div>
            ))}
          </div>
          {duplicate && <div className="mt-2 text-[11.5px] text-warn">Two columns have the same name.</div>}
        </div>
        <div className="flex flex-col items-start gap-2">
          <Checkbox checked={onlyDone} onChange={setOnlyDone} label="Only fully labelled entries" />
          <Checkbox checked={withNotes} onChange={setWithNotes} label="Include notes and flags" />
          {hasContext && (
            <Checkbox
              checked={withContext}
              onChange={setWithContext}
              label={`Include context passages · ${contextTotal} column${contextTotal === 1 ? "" : "s"}, e.g. ${contextExample}`}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Change the session's questions mid-way; answers to unchanged questions are kept. */
function EditQuestionsModal({ s, onClose, onSaved }: { s: LabelSession; onClose: () => void; onSaved: (p: QuestionSetPayload, titles: Record<string, string>) => void }) {
  const { toast } = useApp();
  const [qs, setQs] = useState<QDraft[]>(() => s.questions.questions.map((q) => ({ ...q, key: newKey() })));
  const [context, setContext] = useState(s.questions.context ?? "");
  const [toSet, setToSet] = useState(!!s.question_set_id);
  const [busy, setBusy] = useState(false);
  const valid = qs.length > 0 && qs.every((q) => isComplete(q, context));

  const submit = async () => {
    setBusy(true);
    try {
      const payload: QuestionSetPayload = { context, questions: qs.map(({ key: _k, column: _c, expected: _e, ...q }) => q) };
      const titles = titlesOf(labelQuestions(payload));
      await api.labelSessionUpdate(s.id, { questions: payload, titles });
      if (toSet && s.question_set_id) {
        const cur = await api.questionSet(s.question_set_id);
        await api.questionSetSave({ id: cur.id, name: cur.name, description: cur.description, payload });
      }
      onSaved(payload, titles);
      onClose();
      toast("Questions updated", "good");
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title="Questions of this session"
      footer={
        <>
          {s.question_set_id && (
            <span className="mr-auto self-center">
              <Checkbox checked={toSet} onChange={setToSet} label="Also save as a new version of the question set" />
            </span>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Save questions
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
        <p className="text-[12.5px] text-muted-foreground">Answers stay with questions whose wording you keep; reworded questions start empty.</p>
        <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context every question should know (optional)" />
        <div className="divide-y divide-border">
          {qs.map((q, i) => (
            <QuestionEditor key={q.key} q={q} index={i} invalid={!isComplete(q, context)} routing={{ qs, setQs }} onChange={(p) => setQs(qs.map((x) => (x.key === q.key ? { ...x, ...p } : x)))} onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined} />
          ))}
          <div className="pt-3">
            <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, blank()])}>
              Add question
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A question's full context and option descriptions; as wide as the text needs, closed with Esc. */
function QuestionDetails({ q, onClose }: { q: LabelQuestion | null; onClose: () => void }) {
  const described = q?.choices.filter((c) => c.description) ?? [];
  const longest = q ? Math.max(q.q.context.length, ...described.map((c) => c.label.length + c.description!.length)) : 0;
  // Short notes get a compact dialog; long guidance a wide one that stays readable.
  const width = Math.round(Math.min(760, Math.max(420, 300 + Math.sqrt(longest) * 14)));
  return (
    <Modal open={!!q} onClose={onClose} width={width} title={q?.title ?? ""}>
      {q && (
        <div className="space-y-4">
          {q.q.context.trim() && <p className="leading-relaxed whitespace-pre-wrap text-foreground">{q.q.context.trim()}</p>}
          {described.length > 0 && (
            <dl className="space-y-2 border-t border-border pt-3">
              {described.map((c) => (
                <div key={c.value} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-3">
                  <dt className="font-medium">{c.label}</dt>
                  <dd className="leading-relaxed whitespace-pre-wrap text-muted-foreground">{c.description}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="text-[11.5px] text-faint">Esc to close</div>
        </div>
      )}
    </Modal>
  );
}
