import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProbBars } from "../components/charts";
import { ModelMenu, ModelPicker } from "../components/ModelPicker";
import { QuestionsSection, SharedContext } from "../components/QuestionsSection";
import { EmptyResults, OutdatedBanner, RunHint } from "../components/RunPieces";
import { Badge, Button, Card, ErrorNote, PageHeader, Section, Spinner, Textarea } from "../components/ui";
import { useRunShortcut } from "../lib/useRunShortcut";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { modelColor, ms, pct, shortModel, usd } from "../lib/format";
import { handoff } from "../lib/handoff";
import { load, save } from "../lib/persist";
import { consensusKey, fmt, headline, SAMPLE_TEXT, useQuestionDraft } from "../lib/questionDraft";
import type { AnyAnswer, QuickResult } from "../lib/types";

type Slot = { model: string; result?: QuickResult; error?: unknown; loading: boolean };

interface Saved {
  text: string;
  selected: string[];
  slots: Slot[];
  titles: Record<string, string>;
  ranWith: string | null;
}

/** One entry, several models side by side. Shares its questions with Bulk. */
export function Playground() {
  const { models, cloudModels, refreshBudget } = useApp();
  const draft = useQuestionDraft();
  const { built, invalid } = draft;
  // Input, models and results survive navigation and restarts (stored per user on this Mac).
  const saved = useMemo(() => load<Saved | null>("quick", null), []);
  const incoming = useMemo(() => handoff.take(), []);
  const [text, setText] = useState(incoming?.text ?? saved?.text ?? SAMPLE_TEXT);
  const [selected, setSelected] = useState<string[]>(saved?.selected ?? []);
  const [slots, setSlots] = useState<Slot[]>(incoming ? [] : (saved?.slots ?? []).filter((x) => !x.loading));
  const [titles, setTitles] = useState<Record<string, string>>(saved?.titles ?? {});
  const [ranWith, setRanWith] = useState<string | null>(incoming ? null : saved?.ranWith ?? null);

  useEffect(() => {
    if (selected.length === 0 && (models.length || cloudModels.length)) setSelected([models[0]?.name ?? cloudModels[0].id]);
  }, [models, cloudModels, selected.length]);

  useEffect(() => {
    save("quick", { text, selected, slots, titles, ranWith } satisfies Saved);
  }, [text, selected, slots, titles, ranWith]);

  // Results are "outdated" once the input or questions differ from the last run.
  const signature = JSON.stringify({ text, q: built.map((b) => b.q) });
  const outdated = slots.length > 0 && ranWith !== null && ranWith !== signature && !slots.some((x) => x.loading);
  const canRun = !!text.trim() && selected.length > 0 && built.length > 0 && invalid === 0;
  const running = slots.some((s) => s.loading);

  const run = useCallback(async () => {
    if (!canRun || running) return;
    const order = [...selected];
    const questions = Object.fromEntries(built.map((b) => [b.id, b.q!]));
    setTitles(Object.fromEntries(built.map((b) => [b.id, b.title])));
    setSlots(order.map((m) => ({ model: m, loading: true })));
    setRanWith(signature);
    const one = async (model: string) => {
      try {
        const result = await api.quickClassify({ model, state: text, questions });
        setSlots((s) => s.map((x) => (x.model === model ? { model, result, loading: false } : x)));
      } catch (e) {
        setSlots((s) => s.map((x) => (x.model === model ? { model, error: e, loading: false } : x)));
      }
    };
    // Local models run one after another (each may need loading into memory); cloud models run alongside.
    const local = order.filter((m) => !m.startsWith("@"));
    const cloud = order.filter((m) => m.startsWith("@"));
    await Promise.all([
      (async () => {
        for (const m of local) await one(m);
      })(),
      ...cloud.map(one),
    ]);
    if (cloud.length) refreshBudget();
  }, [built, canRun, refreshBudget, running, selected, signature, text]);

  useRunShortcut(run);

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="One entry, several models side by side."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3" />} onClick={() => { draft.reset(); setText(SAMPLE_TEXT); setSlots([]); setRanWith(null); }}>
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

      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] gap-10">
        <div>
          <Section title="Input">
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a message, ticket, abstract, review…" />
            <SharedContext />
          </Section>
          <QuestionsSection />
          {selected.length === 0 && (
            <Section title="Models">
              <ModelPicker value={selected} onChange={setSelected} colors={modelColor} />
            </Section>
          )}
        </div>

        <div className="self-start">
          {slots.length === 0 ? (
            <EmptyResults />
          ) : (
            <div className="space-y-3">
              {outdated && <OutdatedBanner onRun={run} />}
              <div className={cn("space-y-3 transition-opacity duration-300", outdated && "opacity-45")}>
                {slots.length > 1 && <Consensus slots={slots} titles={titles} />}
                {slots.map((s, i) => (
                  <ResultCard key={s.model} slot={s} titles={titles} color={modelColor(selected.indexOf(s.model) >= 0 ? selected.indexOf(s.model) : i)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
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
        Models agree on {agreed} of {rows.length} question{rows.length === 1 ? "" : "s"}
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

function ResultCard({ slot, color, titles }: { slot: Slot; color: string; titles: Record<string, string> }) {
  const r = slot.result;
  const many = r ? Object.keys(r.answers).length > 1 : false;
  return (
    <Card className="overflow-hidden fade-up">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className="size-2 rounded-full" style={{ background: color }} />
        <span className="text-[13px] font-semibold">{shortModel(slot.model)}</span>
        {r?.routing && <Badge>→ {r.answered_by}</Badge>}
        {r?.state_truncated && <Badge tone="warn">truncated</Badge>}
        {!!r?.refused?.length && <Badge tone="warn">refused {r.refused.length}</Badge>}
        <div className="flex-1" />
        {slot.loading && <Spinner delay={0} />}
        {r && (
          <span className="font-mono text-[11px] text-muted-foreground tnum">
            {ms(r.latency_ms)}
            {r.load_ms > 50 && <span className="text-faint"> + {ms(r.load_ms)} load</span>}
            {!!r.cost_usd && <span className="text-faint"> · {usd(r.cost_usd)}</span>}
          </span>
        )}
      </div>
      <div className="px-4 pt-2 pb-4">
        {slot.loading && !r && <div className="h-14 rounded-[8px] shimmer" />}
        {slot.error !== undefined && <ErrorNote error={slot.error} />}
        {r && (
          <div className="divide-y divide-border">
            {Object.entries(r.answers).map(([id, a]) => (
              <div key={id} className="py-3 first:pt-1 last:pb-0">
                <AnswerView title={many ? titles[id] ?? id : undefined} a={a} color={color} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function AnswerView({ title, a, color }: { title?: string; a: AnyAnswer; color: string }) {
  return (
    <div>
      {title && <div className="mb-0.5 truncate text-[11.5px] text-muted-foreground">{title}</div>}
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-[-0.01em]">{headline(a)}</span>
        {"confidence" in a && <span className="text-[12px] text-muted-foreground">confidence {pct(a.confidence, 0)}</span>}
        {a.type === "score" && <span className="font-mono text-[11.5px] text-faint">score {a.score.toFixed(2)}</span>}
      </div>

      {a.type === "choice" && <ProbBars probs={a.probabilities} highlight={a.choice} color={color} />}
      {a.type === "score" && <ProbBars probs={a.probabilities} highlight={String(Math.round(a.score))} color={color} legend={a.legend} />}

      {a.type === "noul" && (
        <div className="space-y-1">
          <div className="relative h-2 overflow-hidden rounded-full bg-sel">
            <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${a.noul * 100}%`, background: color }} />
            <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/25" />
          </div>
          <div className="flex justify-between font-mono text-[11px] text-faint">
            <span>no</span>
            <span className="text-foreground">p = {a.noul.toFixed(3)}</span>
            <span>yes</span>
          </div>
        </div>
      )}

      {a.type === "multi" && (
        <div className="space-y-1.5">
          {Object.entries(a.probabilities).map(([k, v]) => {
            const on = a.selected.includes(k);
            return (
              <div key={k} className="grid grid-cols-[minmax(0,9rem)_1fr_3.2rem] items-center gap-2.5 text-[12.5px]">
                <div className={cn("truncate", on ? "font-semibold" : "text-muted-foreground")}>{k}</div>
                <div className="relative h-2 overflow-hidden rounded-full bg-sel">
                  <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${v * 100}%`, background: on ? color : "var(--border-strong)" }} />
                  <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${a.threshold * 100}%` }} title={`threshold ${a.threshold}`} />
                </div>
                <div className={cn("text-right font-mono text-[11px] tnum", on ? "text-foreground" : "text-faint")}>{pct(v, 0)}</div>
              </div>
            );
          })}
        </div>
      )}

      {a.type === "rank" && (
        <ol className="space-y-1">
          {a.ranking.map((k, i) => (
            <li key={k} className="grid grid-cols-[1.25rem_minmax(0,9rem)_1fr_3.2rem] items-center gap-2 text-[12.5px]">
              <span className="font-mono text-[11px] text-faint">{i + 1}</span>
              <span className={cn("truncate", i === 0 ? "font-semibold" : "text-muted-foreground")}>{k}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-sel">
                <div className="h-full rounded-full" style={{ width: `${a.probabilities[k] * 100}%`, background: i === 0 ? color : "var(--border-strong)" }} />
              </div>
              <span className="text-right font-mono text-[11px] text-faint tnum">{pct(a.probabilities[k], 0)}</span>
            </li>
          ))}
        </ol>
      )}

      {a.type === "number" && <NumberView a={a} color={color} />}
    </div>
  );
}

function NumberView({ a, color }: { a: Extract<AnyAnswer, { type: "number" }>; color: string }) {
  const entries = Object.entries(a.probabilities);
  const max = Math.max(...entries.map(([, v]) => v), 1e-9);
  return (
    <div>
      <div className="mb-2 text-[12px] text-muted-foreground">
        most likely <b className="text-foreground">{fmt(a.most_likely)}</b> · 80% range{" "}
        <b className="text-foreground">
          {fmt(a.range[0])}–{fmt(a.range[1])}
        </b>
        {a.unit ? ` ${a.unit}` : ""}
      </div>
      <div className="flex h-16 items-end gap-1">
        {entries.map(([k, v]) => {
          const inRange = Number(k) >= a.range[0] && Number(k) <= a.range[1];
          return (
            <div key={k} className="flex flex-1 flex-col items-center gap-1" title={`${k}: ${pct(v)}`}>
              <div className="w-full rounded-t-[3px] transition-[height] duration-500 ease-out" style={{ height: `${(v / max) * 48}px`, background: inRange ? color : "var(--border-strong)", opacity: inRange ? 1 : 0.7 }} />
              <span className="font-mono text-[10px] text-faint">{k}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
