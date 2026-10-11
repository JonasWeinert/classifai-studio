import { cn } from "@/lib/utils";
import { Panes } from "../components/Panes";
import { ChevronLeft, ChevronRight, CornerDownRight, Database, RotateCcw } from "lucide-react";
import { EntryPicker } from "../components/EntryPicker";
import { composeInput } from "../components/OpenRowModal";
import { api } from "../lib/api";
import type { Row } from "../lib/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnswerView } from "../components/AnswerView";
import { ExplainPanel, QuoteExplain } from "../components/ExplainPanel";
import { ModelMenu, ModelPicker } from "../components/ModelPicker";
import { QuestionsSection, SharedContext } from "../components/QuestionsSection";
import { EmptyResults, ModelLoading, OutdatedBanner, RunHint } from "../components/RunPieces";
import { fastestOrder, useModelState } from "../lib/modelStatus";
import { Badge, Button, Card, Disclosure, ErrorNote, PageHeader, Section, Spinner, Term, Textarea } from "../components/ui";
import { GLOSSARY } from "../lib/glossary";
import { useRunShortcut } from "../lib/useRunShortcut";
import { useApp } from "../lib/app";
import { modelColor, ms, shortModel, usd } from "../lib/format";
import { handoff, type Origin } from "../lib/handoff";
import { load, save } from "../lib/persist";
import { consensusKey, SAMPLE_TEXT, useQuestionDraft } from "../lib/questionDraft";
import type { AnyQuestion } from "../lib/types";
import { classifyRouted, type RoutedItem, type RoutedResult } from "../lib/routing";
import { isLlm, supportsFreeText } from "../lib/models";

type Slot = { model: string; result?: RoutedResult; error?: unknown; loading: boolean };

interface Saved {
  text: string;
  selected: string[];
  slots: Slot[];
  titles: Record<string, string>;
  ranWith: string | null;
  /** The dataset row the input came from, while the input is unchanged. */
  origin?: (Origin & { text: string }) | null;
  /** Question id -> the row's value for it, captured at run time. */
  expected?: Record<string, string>;
  /** The input and questions of the last run, for "Why this answer?". */
  ranInput?: RanInput | null;
}

type RanInput = { text: string; questions: Record<string, AnyQuestion> };

/** One entry, several models side by side. Shares its questions with Bulk. */
export function Playground() {
  const { models, cloudModels, refreshBudget, go } = useApp();
  const draft = useQuestionDraft();
  // Free-text questions go only to LLMs; decision models skip them (see lib/models).
  const built = useMemo(() => draft.built.filter((b) => b.q), [draft.built]);
  const { invalid } = draft;
  // Input, models and results survive navigation and restarts (stored per user on this Mac).
  const saved = useMemo(() => load<Saved | null>("quick", null), []);
  const incoming = useMemo(() => handoff.take(), []);
  const [text, setText] = useState(incoming?.text ?? saved?.text ?? SAMPLE_TEXT);
  const [selected, setSelected] = useState<string[]>(saved?.selected ?? []);
  const [slots, setSlots] = useState<Slot[]>(incoming ? [] : (saved?.slots ?? []).filter((x) => !x.loading));
  const [titles, setTitles] = useState<Record<string, string>>(saved?.titles ?? {});
  const [ranWith, setRanWith] = useState<string | null>(incoming ? null : saved?.ranWith ?? null);
  const [origin, setOrigin] = useState<Saved["origin"]>(incoming ? (incoming.origin ? { ...incoming.origin, text: incoming.text } : null) : saved?.origin ?? null);
  const [expected, setExpected] = useState<Record<string, string>>(incoming ? {} : saved?.expected ?? {});
  const [ranInput, setRanInput] = useState<RanInput | null>(incoming ? null : saved?.ranInput ?? null);
  const fromRow = origin && origin.text === text ? origin : null;
  const [picking, setPicking] = useState(false);
  const [moving, setMoving] = useState(false);

  /** Show another entry of the same dataset: its input, and its values next to the answers. */
  const showRow = useCallback(
    ([i, row]: [number, Row]) => {
      if (!origin?.inputCols) return;
      const t = composeInput(row, origin.inputCols);
      setText(t);
      setOrigin({ ...origin, row: i, text: t });
      draft.setQs(draft.qs.map((q) => (q.column ? { ...q, expected: row[q.column] ?? "" } : q)));
      setSlots([]);
      setRanWith(null);
    },
    [draft, origin],
  );
  const step = useCallback(
    async (d: number) => {
      if (!fromRow?.inputCols || moving) return;
      const i = fromRow.row + d;
      if (i < 0 || (fromRow.rowCount !== undefined && i >= fromRow.rowCount)) return;
      setMoving(true);
      try {
        const [hit] = await api.datasetRowsAt(fromRow.datasetId, [i]);
        if (hit) showRow(hit);
      } finally {
        setMoving(false);
      }
    },
    [fromRow, moving, showRow],
  );
  // ⌥↑ / ⌥↓: previous / next entry (not while typing, where they move the cursor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      step(e.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  // Questions made from dataset columns replace the draft (once, when arriving from a dataset).
  useEffect(() => {
    if (incoming?.questions) {
      draft.setQs(incoming.questions);
      draft.setSet(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  useEffect(() => {
    if (selected.length === 0 && (models.length || cloudModels.length)) setSelected([models[0]?.name ?? cloudModels[0].id]);
  }, [models, cloudModels, selected.length]);

  useEffect(() => {
    save("quick", { text, selected, slots, titles, ranWith, origin, expected, ranInput } satisfies Saved);
  }, [text, selected, slots, titles, ranWith, origin, expected, ranInput]);

  // Results are "outdated" once the input or questions differ from the last run.
  const signature = JSON.stringify({ text, q: built.map((b) => [b.q, b.route]) });
  const outdated = slots.length > 0 && ranWith !== null && ranWith !== signature && !slots.some((x) => x.loading);
  // Something to ask: a question every model answers, or free text with an LLM selected.
  const answerable = built.some((b) => b.q!.type !== "text") || (built.length > 0 && selected.some(supportsFreeText));
  const canRun = !!text.trim() && selected.length > 0 && answerable && invalid === 0;
  const allFreeText = draft.built.length > 0 && !answerable;
  const running = slots.some((s) => s.loading);

  const run = useCallback(async () => {
    if (!canRun || running) return;
    const order = [...selected];
    const items: RoutedItem[] = built.map((b) => ({ id: b.id, title: b.title, q: b.q!, route: b.route }));
    // "Why?" explains the first pass: the questions asked about the input as it is.
    const questions = Object.fromEntries(built.filter((b) => b.q!.type !== "text" && (!b.route || !built.some((p) => p.id === b.route!.parent))).map((b) => [b.id, b.q!]));
    setTitles(Object.fromEntries(built.map((b) => [b.id, b.title])));
    setExpected(fromRow ? Object.fromEntries(draft.built.flatMap((b, i) => (b.q && draft.qs[i]?.expected !== undefined ? [[b.id, draft.qs[i].expected!]] : []))) : {});
    setSlots(order.map((m) => ({ model: m, loading: true })));
    setRanWith(signature);
    setRanInput({ text, questions });
    // Fastest first: cloud alongside, then local models in memory, then the rest smallest first.
    const queue = await fastestOrder(order, models);
    const one = async (model: string) => {
      try {
        // Decision models skip free-text questions.
        const result = await classifyRouted(model, text, items.filter((i) => i.q.type !== "text" || supportsFreeText(model)));
        setSlots((s) => s.map((x) => (x.model === model ? { model, result, loading: false } : x)));
      } catch (e) {
        setSlots((s) => s.map((x) => (x.model === model ? { model, error: e, loading: false } : x)));
      }
    };
    // Local models run one after another (each may need loading into memory); cloud models run alongside.
    const local = queue.filter((m) => !m.startsWith("@"));
    const cloud = queue.filter((m) => m.startsWith("@"));
    await Promise.all([
      (async () => {
        for (const m of local) await one(m);
      })(),
      ...cloud.map(one),
    ]);
    if (cloud.length) refreshBudget();
  }, [built, canRun, draft.qs, fromRow, models, refreshBudget, running, selected, signature, text]);

  useRunShortcut(run);

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="One entry, several models side by side."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3" />} onClick={() => { draft.reset(); setText(SAMPLE_TEXT); setSlots([]); setRanWith(null); setOrigin(null); setExpected({}); }}>
              Reset
            </Button>
            <ModelMenu value={selected} onChange={setSelected} colors={modelColor} />
            <Button variant="primary" onClick={run} disabled={!canRun} loading={running}>
              {running ? `${slots.filter((x) => !x.loading).length} of ${slots.length}` : "Classify"}
              <RunHint />
            </Button>
          </>
        }
      />

      <Panes template="minmax(0,1.05fr) minmax(0,1fr)" className="gap-10">
        <div>
          <Section
            title="Input"
            actions={
              fromRow &&
              (fromRow.inputCols ? (
                <div className="inline-flex items-center rounded-full bg-sel text-[11.5px] text-muted-foreground">
                  <button title="Previous entry (⌥↑)" disabled={fromRow.row <= 0 || moving} onClick={() => step(-1)} className="rounded-l-full py-0.5 pr-0.5 pl-1.5 hover:text-foreground disabled:opacity-35">
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <button title="Choose another entry" onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 px-1.5 py-0.5 hover:text-foreground">
                    <Database className="size-3" />
                    Entry {fromRow.row + 1}
                    {fromRow.rowCount ? ` of ${fromRow.rowCount.toLocaleString()}` : ""} · {fromRow.datasetName}
                  </button>
                  <button title="Next entry (⌥↓)" disabled={(fromRow.rowCount !== undefined && fromRow.row >= fromRow.rowCount - 1) || moving} onClick={() => step(1)} className="rounded-r-full py-0.5 pr-1.5 pl-0.5 hover:text-foreground disabled:opacity-35">
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              ) : (
                <button onClick={() => go({ page: "dataset", id: fromRow.datasetId })} className="inline-flex items-center gap-1.5 rounded-full bg-sel px-2.5 py-0.5 text-[11.5px] text-muted-foreground hover:text-foreground">
                  <Database className="size-3" />
                  Row {fromRow.row + 1} of {fromRow.datasetName}
                </button>
              ))
            }
          >
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a message, ticket, abstract, review…" />
            <SharedContext />
            {fromRow?.inputCols && (
              <EntryPicker
                open={picking}
                datasetId={fromRow.datasetId}
                datasetName={fromRow.datasetName}
                inputCols={fromRow.inputCols}
                current={fromRow.row}
                onClose={() => setPicking(false)}
                onPick={(r) => {
                  showRow(r);
                  setPicking(false);
                }}
              />
            )}
          </Section>
          <QuestionsSection models={selected} />
          {selected.length === 0 && (
            <Section title="Models">
              <ModelPicker value={selected} onChange={setSelected} colors={modelColor} />
            </Section>
          )}
        </div>

        <div className="self-start">
          {slots.length === 0 ? (
            allFreeText ? (
              <div className="grid min-h-[360px] place-items-center rounded-[14px] border border-dashed border-border-strong px-8 text-center">
                <div>
                  <div className="text-[13px] font-medium text-muted-foreground">Nothing these models can answer</div>
                  <div className="mt-1 max-w-sm text-[12px] text-faint">Every question is free text, which only LLMs answer. Select an LLM (Models → Cloud → LLMs), or add a choice, yes/no, scale or number question.</div>
                </div>
              </div>
            ) : (
              <EmptyResults />
            )
          ) : (
            <div className="space-y-3">
              {outdated && <OutdatedBanner onRun={run} />}
              <div className={cn("space-y-3 transition-opacity duration-300", outdated && "opacity-45")}>
                {slots.length > 1 && <Consensus slots={slots} titles={titles} />}
                <ReadingGuide />
                {slots.map((s, i) => (
                  <ResultCard key={`${s.model}|${ranWith}`} slot={s} titles={titles} expected={expected} input={outdated ? null : ranInput} freeText={built.filter((b) => b.q!.type === "text").map((b) => b.id)} color={modelColor(selected.indexOf(s.model) >= 0 ? selected.indexOf(s.model) : i)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </Panes>
    </>
  );
}

/** How to read the numbers, for people new to probabilistic classifiers. Collapsed; hover any dotted term for the same help. */
function ReadingGuide() {
  return (
    <Disclosure label="How to read these results" className="px-1">
      <div className="space-y-2 rounded-[12px] bg-card px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
        <p>
          <b className="font-medium text-foreground">“57% likely · leaning”</b> — the percentage is the chance the model gives its answer, the same number as the
          highlighted bar. The word says how clear-cut that is for the number of options: 57% out of three is only leaning, out of ten it would be a clear pick. Both are the model’s
          own estimate, not proof that it is right.
        </p>
        <p>
          <b className="font-medium text-foreground">Chance of yes</b> on yes/no questions is a probability from 0 to 100%. It is <i>not</i> a p-value: nothing is being tested
          for significance. Above 50% reads as Yes; around 50% the model can't tell.
        </p>
        <p>
          <b className="font-medium text-foreground">The bars</b> show how the model spreads its belief over the options. When two options are close, the question or the text may be
          ambiguous — worth a look, or a clearer description of the options.
        </p>
        <p>
          <b className="font-medium text-foreground">Is it actually right?</b> One example can't say. To learn how often a model is right, and whether its confidence can be
          trusted, run an experiment on rows you've already labelled.
        </p>
        <p className="text-faint">Hover any dotted term for a short explanation.</p>
      </div>
    </Disclosure>
  );
}

function Consensus({ slots, titles }: { slots: Slot[]; titles: Record<string, string> }) {
  const done = slots.filter((s) => s.result);
  if (done.length < 2) return null;
  const ids = Object.keys(done[0].result!.answers);
  const rows = ids.map((id) => {
    const keys = done.map((s) => (s.result!.answers[id] ? consensusKey(s.result!.answers[id]) : "—"));
    return { id, agree: new Set(keys).size === 1, value: keys[0] };
  });
  const agreed = rows.filter((r) => r.agree).length;
  return (
    <div className="rounded-[14px] bg-card px-4 py-3 fade-up">
      <div className="mb-1.5 text-[12.5px] font-semibold">
        <Term tip={GLOSSARY.agreement}>
          Models agree on {agreed} of {rows.length} question{rows.length === 1 ? "" : "s"}
        </Term>
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-[12px]">
            <span className={cn("size-1.5 shrink-0 rounded-full", r.agree ? "bg-good" : "bg-warn")} />
            <span className="truncate text-muted-foreground">{titles[r.id] ?? r.id}</span>
            <span className="ml-auto shrink-0 font-medium">{r.agree ? r.value : "disagree"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultCard({ slot, color, titles, expected, input, freeText }: { slot: Slot; color: string; titles: Record<string, string>; expected: Record<string, string>; input: RanInput | null; freeText: string[] }) {
  const llm = isLlm(slot.model);
  const r = slot.result;
  const many = r ? Object.keys(r.answers).length > 1 : false;
  return (
    <Card className="overflow-hidden fade-up">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className="size-2 rounded-full" style={{ background: color }} />
        <span className="text-[13px] font-semibold">{shortModel(slot.model)}</span>
        {llm && (
          <span title="An LLM answering through structured output. Its probabilities are its own estimates, usually less calibrated than a decision model's.">
            <Badge tone="accent">LLM</Badge>
          </span>
        )}
        {r?.routing && <Badge>→ {r.answered_by}</Badge>}
        {r?.state_truncated && <Badge tone="warn">truncated</Badge>}
        {!!r?.refused?.length && <Badge tone="warn">refused {r.refused.length}</Badge>}
        <div className="flex-1" />
        {slot.loading && <Spinner delay={0} />}
        {r && (
          <span className="font-mono text-[11px] text-muted-foreground tnum">
            <Term tip={GLOSSARY.latency}>{ms(r.latency_ms)}</Term>
            {(r.passes ?? 1) > 1 && <Term tip="Follow-up questions were asked in further requests; the time adds up." className="text-faint"> · {r.passes} passes</Term>}
            {r.load_ms > 50 && (
              <span className="text-faint">
                {" "}
                + <Term tip={GLOSSARY.load}>{ms(r.load_ms)} load</Term>
              </span>
            )}
            {!!r.cost_usd && <span className="text-faint"> · {usd(r.cost_usd)}</span>}
          </span>
        )}
      </div>
      <div className="px-4 pt-2 pb-4">
        {slot.loading && !r && <SlotLoading model={slot.model} />}
        {slot.error !== undefined && <ErrorNote error={slot.error} />}
        {r && (
          <div className="divide-y divide-border">
            {Object.entries(r.answers).map(([id, a]) => {
              const via = r.followUps?.[id];
              return (
                <div key={id} className={cn("py-3 first:pt-1 last:pb-0", via && "pl-4")}>
                  {via && (
                    <div className="mb-1 flex items-center gap-1 text-[11px] text-faint" title="Asked in a later pass, with the earlier question and its answer added to the input">
                      <CornerDownRight className="size-3" />
                      Follow-up · asked because “{titles[via.parent] ?? via.parent}” → <b className="font-medium text-muted-foreground">{via.answer}</b>
                    </div>
                  )}
                  <AnswerView title={many || via ? titles[id] ?? id : undefined} a={a} color={color} expected={expected[id]} />
                </div>
              );
            })}
          </div>
        )}
        {r && !llm && freeText.some((id) => titles[id]) && (
          <div className="mt-3 text-[11.5px] text-faint" title="Only LLMs answer free-text questions">
            Free text skipped (decision model): {freeText.map((id) => titles[id] ?? id).join(" · ")}
          </div>
        )}
        {r && !!r.notAsked?.length && (
          <div className="mt-3 text-[11.5px] text-faint" title="Follow-ups are asked only when their earlier question gets one of the chosen answers">
            Not asked (condition not met): {r.notAsked.map((id) => titles[id] ?? id).join(" · ")}
          </div>
        )}
        {r && input && Object.keys(r.answers).length > 0 &&
          (llm ? (
            <QuoteExplain text={input.text} titles={titles} result={r} color={color} />
          ) : (
            <ExplainPanel model={slot.model} text={input.text} questions={input.questions} titles={titles} result={r} color={color} />
          ))}
      </div>
    </Card>
  );
}

/** While a slot waits: the model's warm-up if it is loading, otherwise a placeholder. */
function SlotLoading({ model }: { model: string }) {
  const { state, since } = useModelState(model);
  return state === "loading" ? (
    <div className="space-y-2">
      <ModelLoading model={model} since={since} />
      <div className="h-8 rounded-[8px] shimmer" />
    </div>
  ) : (
    <div className="h-14 rounded-[8px] shimmer" />
  );
}
