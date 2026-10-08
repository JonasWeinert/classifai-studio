import clsx from "clsx";
import { Braces, CornerDownLeft, Plus, RotateCcw, Sparkles, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProbBars } from "../components/charts";
import { ModelPicker } from "../components/ModelPicker";
import { Badge, Button, Card, ErrorNote, Input, Kbd, Label, PageHeader, Segmented, Select, Spinner, Textarea } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { modelColor, ms, pct, shortModel } from "../lib/format";
import type { Answer, Question, QuickResult } from "../lib/types";

type Mode = "labels" | "yesno" | "scale" | "preset";

interface Draft {
  mode: Mode;
  instructions: string;
  labels: { name: string; description: string }[];
  statement: string;
  levels: string[];
  preset: string;
}

const EXAMPLE: Draft = {
  mode: "labels",
  instructions: "Which team should handle this message?",
  labels: [
    { name: "billing", description: "Payments, invoices and refunds" },
    { name: "technical", description: "Bugs, errors and outages" },
    { name: "account", description: "Login, profile and settings" },
  ],
  statement: "The customer asks for money back.",
  levels: ["Can wait", "Needs attention this week", "Needs attention today"],
  preset: "triage",
};

const SAMPLE_TEXT = "Third time this year you've double-charged me. Refund it today or I'm cancelling and moving to a competitor.";

function buildQuestions(d: Draft): Record<string, Question> | null {
  const instructions = d.instructions.trim() || undefined;
  if (d.mode === "labels") {
    const labels = d.labels.filter((l) => l.name.trim());
    if (labels.length < 2) return null;
    return { answer: { type: "choice", instructions, criteria: Object.fromEntries(labels.map((l) => [l.name.trim(), l.description.trim() || null])) } };
  }
  if (d.mode === "yesno") {
    if (!d.statement.trim()) return null;
    return { answer: { type: "noul", instructions: d.statement.trim() } };
  }
  if (d.mode === "scale") {
    const levels = d.levels.map((l) => l.trim()).filter(Boolean);
    if (levels.length < 2) return null;
    return { answer: { type: "score", instructions, criteria: levels } };
  }
  return null;
}

type Slot = { model: string; result?: QuickResult; error?: string; loading: boolean };

export function QuickCheck() {
  const { models, engine } = useApp();
  const [text, setText] = useState(SAMPLE_TEXT);
  const [asJson, setAsJson] = useState(false);
  const [draft, setDraft] = useState<Draft>(EXAMPLE);
  const [selected, setSelected] = useState<string[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const presets = useAsync(() => (engine?.running ? api.presets() : Promise.resolve([])), [engine?.running]);

  useEffect(() => {
    if (selected.length === 0 && models.length) setSelected([models[0].name]);
  }, [models, selected.length]);

  const questions = useMemo(() => buildQuestions(draft), [draft]);
  const canRun = text.trim() && selected.length > 0 && (draft.mode === "preset" ? !!draft.preset : !!questions);
  const running = slots.some((s) => s.loading);

  const run = useCallback(async () => {
    if (!canRun || running) return;
    const order = [...selected];
    setSlots(order.map((m) => ({ model: m, loading: true })));
    // One model at a time: each may need loading into memory, and results appear as they land.
    for (const model of order) {
      try {
        const result = await api.quickClassify({
          model,
          state: text,
          as_json: asJson,
          ...(draft.mode === "preset" ? { preset: draft.preset } : { questions: questions! }),
        });
        setSlots((s) => s.map((x) => (x.model === model ? { model, result, loading: false } : x)));
      } catch (e) {
        setSlots((s) => s.map((x) => (x.model === model ? { model, error: errorMessage(e), loading: false } : x)));
      }
    }
  }, [asJson, canRun, draft.mode, draft.preset, questions, running, selected, text]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [run]);

  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <>
      <PageHeader title="Quick check" subtitle="Drop in a single entry and see how each model classifies it." />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        {/* ---- input ---- */}
        <div className="space-y-4">
          <Card className="p-4">
            <Label
              hint={
                <button onClick={() => setAsJson(!asJson)} className={clsx("flex items-center gap-1 rounded px-1 hover:text-fg", asJson && "text-accent")}>
                  <Braces className="size-3" /> {asJson ? "JSON input" : "Plain text"}
                </button>
              }
            >
              Input
            </Label>
            <Textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={asJson ? '{"subject": "…", "body": "…"}' : "Paste a message, ticket, review, email…"}
              className={clsx(asJson && "font-mono text-[12.5px]")}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12px] font-medium text-muted">Question</span>
              <Segmented
                size="sm"
                value={draft.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { value: "labels", label: "Labels" },
                  { value: "yesno", label: "Yes / no" },
                  { value: "scale", label: "Scale" },
                  { value: "preset", label: "Preset" },
                ]}
              />
            </div>

            {draft.mode !== "yesno" && draft.mode !== "preset" && (
              <Input className="mb-3" value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="Instructions, e.g. What is the sentiment of this review?" />
            )}

            {draft.mode === "labels" && (
              <div className="space-y-1.5">
                {draft.labels.map((l, i) => (
                  <div key={i} className="grid grid-cols-[9rem_1fr_auto] gap-1.5">
                    <Input value={l.name} placeholder="label" className="font-medium" onChange={(e) => set({ labels: draft.labels.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                    <Input value={l.description} placeholder="Description (optional, helps accuracy)" onChange={(e) => set({ labels: draft.labels.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })} />
                    <Button variant="ghost" size="sm" className="h-8.5 w-8 px-0" onClick={() => set({ labels: draft.labels.filter((_, k) => k !== i) })} disabled={draft.labels.length <= 2}>
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ labels: [...draft.labels, { name: "", description: "" }] })}>
                  Add label
                </Button>
              </div>
            )}

            {draft.mode === "yesno" && (
              <div>
                <Input value={draft.statement} onChange={(e) => set({ statement: e.target.value })} placeholder="A statement that is true or false, e.g. The customer asks for a refund." />
                <div className="mt-1.5 text-[11.5px] text-faint">The model returns the probability that this statement holds.</div>
              </div>
            )}

            {draft.mode === "scale" && (
              <div className="space-y-1.5">
                {draft.levels.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1.75rem_1fr_auto] items-center gap-1.5">
                    <span className="text-center font-mono text-[11px] text-faint">{i}</span>
                    <Input value={l} onChange={(e) => set({ levels: draft.levels.map((x, k) => (k === i ? e.target.value : x)) })} />
                    <Button variant="ghost" size="sm" className="h-8.5 w-8 px-0" onClick={() => set({ levels: draft.levels.filter((_, k) => k !== i) })} disabled={draft.levels.length <= 2}>
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
                {draft.levels.length < 10 && (
                  <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ levels: [...draft.levels, ""] })}>
                    Add level
                  </Button>
                )}
              </div>
            )}

            {draft.mode === "preset" && (
              <div>
                {presets.loading ? (
                  <Spinner />
                ) : (
                  <>
                    <Select className="w-full" value={draft.preset} onChange={(preset) => set({ preset })} options={(presets.data ?? []).map((p) => ({ value: p.name, label: p.name + (p.builtin ? "" : " (custom)") }))} />
                    <div className="mt-1.5 text-[11.5px] text-faint">{presets.data?.find((p) => p.name === draft.preset)?.description ?? "Ollaya's built-in question sets."}</div>
                  </>
                )}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <Label hint={`${selected.length} selected`}>Models</Label>
            <ModelPicker value={selected} onChange={setSelected} colors={modelColor} />
          </Card>

          <div className="flex items-center gap-3">
            <Button variant="primary" size="lg" onClick={run} disabled={!canRun} loading={running} icon={<Zap className="size-4" />}>
              Classify
            </Button>
            <span className="flex items-center gap-1 text-[12px] text-faint">
              <Kbd>⌘</Kbd>
              <Kbd>
                <CornerDownLeft className="inline size-2.5" />
              </Kbd>
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => { setDraft(EXAMPLE); setText(SAMPLE_TEXT); setSlots([]); }}>
              Reset
            </Button>
          </div>
        </div>

        {/* ---- results ---- */}
        <div className="space-y-3">
          {slots.length === 0 ? (
            <Card className="grid min-h-[420px] place-items-center border-dashed bg-transparent shadow-none">
              <div className="text-center">
                <div className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
                  <Sparkles className="size-5" />
                </div>
                <div className="text-[14px] font-semibold">Results appear here</div>
                <div className="mt-1 text-[12.5px] text-muted">Pick a few models to compare them side by side.</div>
              </div>
            </Card>
          ) : (
            <>
              {slots.length > 1 && <Consensus slots={slots} />}
              {slots.map((s, i) => (
                <ResultCard key={s.model} slot={s} color={modelColor(selected.indexOf(s.model) >= 0 ? selected.indexOf(s.model) : i)} />
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function headline(a: Answer): string {
  if (a.type === "choice") return a.choice;
  if (a.type === "noul") return a.noul >= 0.5 ? "Yes" : "No";
  return a.legend[String(Math.round(a.score))] ?? a.score.toFixed(2);
}

function Consensus({ slots }: { slots: Slot[] }) {
  const done = slots.filter((s) => s.result);
  if (done.length < 2) return null;
  const firstKey = Object.keys(done[0].result!.answers)[0];
  const heads = done.map((s) => headline(s.result!.answers[firstKey]));
  const agree = new Set(heads).size === 1;
  return (
    <div className={clsx("flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[12.5px] fade-up", agree ? "border-good/25 bg-good-soft text-good" : "border-warn/25 bg-warn-soft text-warn")}>
      <span className="font-semibold">{agree ? "All models agree" : "Models disagree"}</span>
      <span className="opacity-80">{agree ? `→ ${heads[0]}` : heads.map((h, i) => `${shortModel(done[i].model)}: ${h}`).join(" · ")}</span>
    </div>
  );
}

function ResultCard({ slot, color }: { slot: Slot; color: string }) {
  const r = slot.result;
  return (
    <Card className="overflow-hidden fade-up">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <span className="size-2.5 rounded-full" style={{ background: color }} />
        <span className="text-[13px] font-semibold">{shortModel(slot.model)}</span>
        {r?.routing && <Badge>→ {r.answered_by}</Badge>}
        {r?.state_truncated && <Badge tone="warn">truncated</Badge>}
        <div className="flex-1" />
        {slot.loading && <Spinner className="size-3.5" />}
        {r && (
          <span className="font-mono text-[11.5px] text-muted tnum">
            {ms(r.latency_ms)}
            {r.load_ms > 50 && <span className="text-faint"> + {ms(r.load_ms)} load</span>}
          </span>
        )}
      </div>
      <div className="px-4 py-3.5">
        {slot.loading && !r && <div className="h-16 rounded-lg shimmer" />}
        {slot.error && <ErrorNote>{slot.error}</ErrorNote>}
        {r && (
          <div className="space-y-4">
            {Object.entries(r.answers).map(([id, a]) => (
              <AnswerView key={id} id={id} a={a} color={color} showId={Object.keys(r.answers).length > 1} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function AnswerView({ id, a, color, showId }: { id: string; a: Answer; color: string; showId: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        {showId && <span className="font-mono text-[11.5px] text-faint">{id}</span>}
        <span className="text-[17px] font-semibold tracking-[-0.015em]">{headline(a)}</span>
        {a.type !== "noul" && <span className="text-[12px] text-muted">confidence {pct(a.confidence, 0)}</span>}
        {a.type === "score" && <span className="font-mono text-[12px] text-faint">score {a.score.toFixed(2)}</span>}
      </div>
      {a.type === "choice" && <ProbBars probs={a.probabilities} highlight={a.choice} color={color} />}
      {a.type === "score" && <ProbBars probs={a.probabilities} highlight={String(Math.round(a.score))} color={color} legend={a.legend} />}
      {a.type === "noul" && (
        <div className="space-y-1">
          <div className="relative h-2.5 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${a.noul * 100}%`, background: color }} />
            <div className="absolute inset-y-0 left-1/2 w-px bg-fg/25" />
          </div>
          <div className="flex justify-between font-mono text-[11px] text-faint">
            <span>no</span>
            <span className="text-fg">p = {a.noul.toFixed(3)}</span>
            <span>yes</span>
          </div>
        </div>
      )}
    </div>
  );
}
