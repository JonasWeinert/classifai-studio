import { cn } from "@/lib/utils";
import { CornerDownLeft, Download, Plus, RotateCcw, Save, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ProbBars } from "../components/charts";
import { ModelMenu, ModelPicker } from "../components/ModelPicker";
import { Badge, Button, Card, Disclosure, ErrorNote, FormRow, Input, Kbd, Modal, PageHeader, Progress, Section, Segmented, Select, Slider, Spinner, Textarea } from "../components/ui";
import { api, pickSavePath } from "../lib/api";
import { guessInputColumns, guessLabelColumn } from "../lib/columns";
import { handoff } from "../lib/handoff";
import { load, save } from "../lib/persist";
import { describeError } from "../lib/errors";
import { useApp, useAsync } from "../lib/app";
import { modelColor, ms, pct, shortModel, usd } from "../lib/format";
import { composeInstructions, slugId } from "../lib/questions";
import type { AnyAnswer, AnyQuestion, Question, QuickResult } from "../lib/types";

type Kind = "choice" | "multi" | "noul" | "score" | "rank" | "number";

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "choice", label: "Pick one", hint: "One label from a list" },
  { value: "multi", label: "Pick any", hint: "Every label that applies — one yes/no per option" },
  { value: "noul", label: "Yes / No", hint: "Probability that a statement is true" },
  { value: "score", label: "Scale", hint: "2–10 ordered levels" },
  { value: "rank", label: "Rank", hint: "All options ordered from most to least fitting" },
  { value: "number", label: "Number", hint: "Expected value and 80% range over candidate values" },
];

interface Opt {
  name: string;
  description: string;
}

interface QDraft {
  key: number;
  kind: Kind;
  /** The question / statement shown to the model. */
  text: string;
  context: string;
  options: Opt[];
  threshold: number;
  yes: string;
  no: string;
  levels: string[];
  values: string;
  unit: string;
}

let nextKey = 1;
const blank = (kind: Kind = "choice", text = ""): QDraft => ({
  key: nextKey++,
  kind,
  text,
  context: "",
  options: [
    { name: "", description: "" },
    { name: "", description: "" },
  ],
  threshold: 0.5,
  yes: "",
  no: "",
  levels: ["Low", "Medium", "High"],
  values: "0, 1, 3, 7, 14, 30",
  unit: "",
});

const EXAMPLE = (): QDraft[] => [
  {
    ...blank("choice", "Which team should handle this message?"),
    options: [
      { name: "billing", description: "Payments, invoices and refunds" },
      { name: "technical", description: "Bugs, errors and outages" },
      { name: "account", description: "Login, profile and settings" },
    ],
  },
  { ...blank("noul", "The customer asks for money back."), yes: "Explicitly requests a refund or chargeback", no: "" },
  { ...blank("score", "How frustrated is the customer?"), levels: ["Calm", "Annoyed", "Frustrated", "Furious"] },
];

const SAMPLE_TEXT = "Third time this year you've double-charged me. Refund it today or I'm cancelling and moving to a competitor.";

function parseValues(s: string) {
  return [...new Set(s.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite))];
}

function buildQuestion(q: QDraft, shared: string): AnyQuestion | null {
  const instructions = composeInstructions(q.text, shared, q.context) || undefined;
  const opts = q.options.filter((o) => o.name.trim());
  const criteria = Object.fromEntries(opts.map((o) => [o.name.trim(), o.description.trim() || null]));
  switch (q.kind) {
    case "choice":
      return opts.length >= 2 ? { type: "choice", instructions, criteria } : null;
    case "rank":
      return opts.length >= 2 ? { type: "rank", instructions, criteria } : null;
    case "multi":
      return opts.length >= 1 ? { type: "multi", instructions, criteria, threshold: q.threshold } : null;
    case "noul": {
      if (!q.text.trim()) return null;
      const yes = q.yes.trim(), no = q.no.trim();
      return { type: "noul", instructions, ...(yes || no ? { criteria: { ...(yes && { true: yes }), ...(no && { false: no }) } } : {}) };
    }
    case "score": {
      const levels = q.levels.map((l) => l.trim()).filter(Boolean);
      return levels.length >= 2 ? { type: "score", instructions, criteria: levels } : null;
    }
    case "number": {
      const values = parseValues(q.values);
      return values.length >= 2 ? { type: "number", instructions, values, unit: q.unit.trim() || null } : null;
    }
  }
}

type Slot = { model: string; result?: QuickResult; error?: unknown; loading: boolean };

interface Saved {
  text: string;
  shared: string;
  qs: QDraft[];
  view: View;
  selected: string[];
  slots: Slot[];
  titles: Record<string, string>;
  ranWith: string | null;
  set: { id: string; name: string; version: number } | null;
}
type View = "single" | "bulk";

export function Playground() {
  const { models, engine, cloudModels, toast, refreshBudget } = useApp();
  // Draft and results survive navigation and restarts (stored per user on this Mac).
  const saved = useMemo(() => load<Saved | null>("quick", null), []);
  const incoming = useMemo(() => handoff.take(), []);
  const [text, setText] = useState(incoming?.text ?? saved?.text ?? SAMPLE_TEXT);
  const [shared, setShared] = useState(saved?.shared ?? "");
  const [qs, setQs] = useState<QDraft[]>(() => (saved?.qs?.length ? saved.qs.map((q) => ({ ...q, key: nextKey++ })) : EXAMPLE()));
  const [view, setView] = useState<View>(incoming ? "single" : saved?.view ?? "single");
  const [selected, setSelected] = useState<string[]>(saved?.selected ?? []);
  const [slots, setSlots] = useState<Slot[]>(incoming ? [] : (saved?.slots ?? []).filter((x) => !x.loading));
  const [titles, setTitles] = useState<Record<string, string>>(saved?.titles ?? {});
  const [ranWith, setRanWith] = useState<string | null>(incoming ? null : saved?.ranWith ?? null);
  const [set, setSet] = useState<{ id: string; name: string; version: number } | null>(saved?.set ?? null);
  const [saving, setSaving] = useState(false);
  const sets = useAsync(() => api.questionSets(), []);
  const presets = useAsync(() => (engine?.running ? api.presets() : Promise.resolve([])), [engine?.running]);

  useEffect(() => {
    if (selected.length === 0 && (models.length || cloudModels.length)) setSelected([models[0]?.name ?? cloudModels[0].id]);
  }, [models, cloudModels, selected.length]);

  useEffect(() => {
    save("quick", { text, shared, qs, view, selected, slots, titles, ranWith, set } satisfies Saved);
  }, [text, shared, qs, view, selected, slots, titles, ranWith, set]);

  // Question ids derive from their text; the map keeps ids unique and readable.
  const built = useMemo(() => {
    const ids: string[] = [];
    const out: { id: string; title: string; q: AnyQuestion | null }[] = [];
    for (const q of qs) {
      const id = slugId(q.text || q.kind, ids);
      ids.push(id);
      out.push({ id, title: q.text.trim() || KINDS.find((k) => k.value === q.kind)!.label, q: buildQuestion(q, shared) });
    }
    return out;
  }, [qs, shared]);

  // Results are "outdated" once the input, questions or models differ from the last run.
  const signature = JSON.stringify({ text, q: built.map((b) => b.q) });
  const outdated = slots.length > 0 && ranWith !== null && ranWith !== signature && !slots.some((x) => x.loading);
  const invalid = built.filter((b) => !b.q).length;
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

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && view === "single") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [run, view]);

  // "Load…" lists saved question sets and Ollaya's presets; presets load as editable questions,
  // so they work with every model (cloud included).
  const loadSource = async (value: string) => {
    if (value.startsWith("preset:")) {
      const name = value.slice(7);
      try {
        const questions = await api.presetShow(name);
        setQs(Object.entries(questions).map(([id, q]) => ({ ...fromWire(id, q), key: nextKey++ })));
        setSet(null);
        toast(`Loaded preset “${name}” as editable questions`, "good");
      } catch (e) {
        toast(describeError(e).message, "bad");
      }
      return;
    }
    const q = await api.questionSet(value);
    setShared(q.payload.context ?? "");
    setQs(q.payload.questions.map((x) => ({ ...x, key: nextKey++ })));
    setSet({ id: q.id, name: q.name, version: q.version });
  };
  const sourceOptions = [
    ...(sets.data ?? []).map((x) => ({ value: x.id, label: `${x.name} · v${x.version}` })),
    ...(presets.data ?? []).map((p) => ({ value: `preset:${p.name}`, label: `Preset: ${p.name}` })),
  ];

  const update = (key: number, patch: Partial<QDraft>) => setQs((all) => all.map((q) => (q.key === key ? { ...q, ...patch } : q)));

  const viewSwitch = (
    <Segmented
      value={view}
      onChange={setView}
      options={[
        { value: "single", label: "Single" },
        { value: "bulk", label: "Bulk" },
      ]}
    />
  );

  const questionsSection = (
    <Section
      title="Questions"
      subtitle="All questions are answered in a single pass per model."
      actions={
        <div className="flex items-center gap-2">
          <Select className="min-w-[10rem]" placeholder="Load…" value={set?.id ?? ""} onChange={loadSource} options={sourceOptions} />
          <Button size="sm" icon={<Save className="size-3" />} onClick={() => setSaving(true)}>
            {set ? "Save" : "Save as set"}
          </Button>
        </div>
      }
    >
      <div className="divide-y divide-border">
        {qs.map((q, i) => (
          <QuestionEditor key={q.key} q={q} index={i} id={built[i]?.id} invalid={!built[i]?.q} onChange={(p) => update(q.key, p)} onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined} />
        ))}
        <div className="pt-3">
          <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, blank()])}>
            Add question
          </Button>
        </div>
      </div>
    </Section>
  );

  const saveSheet = (
    <SaveSetSheet
      open={saving}
      onClose={() => setSaving(false)}
      current={set}
      onSave={async (name, description, asNew) => {
        const summary = await api.questionSetSave({ id: asNew ? null : set?.id, name, description, payload: { context: shared, questions: qs.map(({ key: _k, ...q }) => q) } });
        setSet({ id: summary.id, name: summary.name, version: summary.version });
        sets.reload();
        toast(`Saved “${summary.name}” · v${summary.version}`, "good");
      }}
    />
  );

  if (view === "bulk") {
    return (
      <>
        <Bulk viewSwitch={viewSwitch} questionsSection={questionsSection} built={built} invalid={invalid} shared={shared} setShared={setShared} />
        {saveSheet}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle={set ? `Question set “${set.name}” · v${set.version}` : "Ask several questions about one entry and compare models side by side."}
        actions={
          <>
            {viewSwitch}
            <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3" />} onClick={() => { setQs(EXAMPLE()); setText(SAMPLE_TEXT); setShared(""); setSlots([]); setSet(null); setRanWith(null); }}>
              Reset
            </Button>
            <ModelMenu value={selected} onChange={setSelected} colors={modelColor} />
            <Button variant="primary" onClick={run} disabled={!canRun} loading={running}>
              {running ? `${slots.filter((x) => !x.loading).length} of ${slots.length}` : "Classify"}
              <span className="ml-1 flex items-center gap-0.5 opacity-70">
                <span className="text-[11px]">⌘</span>
                <CornerDownLeft className="size-3" />
              </span>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] gap-10">
        {/* ---- setup, directly on the background ---- */}
        <div>
          <Section title="Input">
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a message, ticket, abstract, review…" />
            <Disclosure className="mt-3" label={shared.trim() ? "Shared context" : "Add shared context"} defaultOpen={!!shared}>
              <Textarea rows={2} value={shared} onChange={(e) => setShared(e.target.value)} placeholder="Background every question should know, e.g. “Messages are from customers of a German telecom.”" />
            </Disclosure>
          </Section>

          {questionsSection}

          {selected.length === 0 && (
            <Section title="Models">
              <ModelPicker value={selected} onChange={setSelected} colors={modelColor} />
            </Section>
          )}
        </div>

        {/* ---- results ---- */}
        <div className="self-start">
          {slots.length === 0 ? (
            <div className="grid min-h-[360px] place-items-center rounded-[14px] border border-dashed border-border-strong">
              <div className="text-center">
                <div className="text-[13px] font-medium text-muted-foreground">No results yet</div>
                <div className="mt-0.5 flex items-center justify-center gap-1 text-[12px] text-faint">
                  Press Classify or <Kbd>⌘</Kbd>
                  <Kbd>↩</Kbd>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {outdated && (
                <div className="flex items-center justify-between rounded-[12px] bg-warn-soft px-4 py-2 text-[12.5px] text-warn fade-up">
                  Inputs changed since these results.
                  <button className="font-medium underline-offset-2 hover:underline" onClick={run}>
                    Re-run ⌘↩
                  </button>
                </div>
              )}
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
      {saveSheet}
    </>
  );
}

function SaveSetSheet({ open, onClose, current, onSave }: { open: boolean; onClose: () => void; current: { id: string; name: string; version: number } | null; onSave: (name: string, description: string, asNew: boolean) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(current?.name ?? "");
  }, [open, current]);
  const submit = async (asNew: boolean) => {
    setBusy(true);
    try {
      await onSave(name.trim(), description.trim(), asNew);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={current ? `Save “${current.name}”` : "Save as question set"}
      footer={
        <>
          {current && (
            <Button className="mr-auto" disabled={!name.trim()} onClick={() => submit(true)}>
              Save as new set
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => submit(false)}>
            {current ? `Save v${current.version + 1}` : "Save"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] text-muted-foreground">Question sets keep questions, descriptions and context together. Reuse them here or start an experiment from one; every save is a new version.</p>
      <div className="-ml-3">
        <FormRow label="Name:" labelWidth={100}>
          <Input value={name} onChange={setName} placeholder="e.g. Ticket triage" autoFocus />
        </FormRow>
        <FormRow label="Description:" labelWidth={100}>
          <Input value={description} onChange={setDescription} placeholder="optional" />
        </FormRow>
      </div>
    </Modal>
  );
}

function QuestionEditor({ q, index, id, invalid, onChange, onRemove }: { q: QDraft; index: number; id?: string; invalid: boolean; onChange: (p: Partial<QDraft>) => void; onRemove?: () => void }) {
  const usesOptions = q.kind === "choice" || q.kind === "multi" || q.kind === "rank";
  const hint = KINDS.find((k) => k.value === q.kind)!.hint;
  return (
    <div className="group/q py-4 first:pt-0 fade-up">
      <div className="mb-2 flex items-center gap-2">
        <span className="w-5 text-[12px] font-semibold text-faint tnum">{index + 1}</span>
        <Input className="flex-1" value={q.text} onChange={(text) => onChange({ text })} placeholder={q.kind === "noul" ? "A statement, e.g. The study is a randomised controlled trial." : "Question, e.g. Which topics does this abstract cover?"} />
        <Select className="min-w-[7.5rem]" value={q.kind} onChange={(k) => onChange({ kind: k as Kind })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        {onRemove && <Button variant="ghost" size="icon" onClick={onRemove} title="Remove question" icon={<Trash2 className="size-3.5" />} />}
      </div>
      <div className="ml-7 space-y-2">
        <div className="flex items-center gap-2 text-[11.5px] text-faint">
          {hint}
          {id && <span className="font-mono opacity-0 transition-opacity group-hover/q:opacity-100">· {id}</span>}
          {invalid && <span className="text-warn">· incomplete</span>}
        </div>

        {usesOptions && (
          <div className="space-y-1.5">
            {q.options.map((o, i) => (
              <div key={i} className="grid grid-cols-[9rem_1fr_auto] gap-1.5">
                <Input value={o.name} placeholder="label" onChange={(v) => onChange({ options: q.options.map((x, k) => (k === i ? { ...x, name: v } : x)) })} />
                <Input value={o.description} placeholder="What this label means (optional, improves accuracy)" onChange={(v) => onChange({ options: q.options.map((x, k) => (k === i ? { ...x, description: v } : x)) })} />
                <Button variant="ghost" size="icon" disabled={q.options.length <= (q.kind === "multi" ? 1 : 2)} onClick={() => onChange({ options: q.options.filter((_, k) => k !== i) })} icon={<X className="size-3.5" />} />
              </div>
            ))}
            <Button variant="ghost" size="sm" icon={<Plus className="size-3" />} onClick={() => onChange({ options: [...q.options, { name: "", description: "" }] })}>
              Option
            </Button>
          </div>
        )}

        {q.kind === "multi" && (
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted-foreground">Select when P ≥</span>
            <Slider className="flex-1" value={q.threshold} onChange={(threshold) => onChange({ threshold })} min={0.05} max={0.95} step={0.05} />
            <span className="w-9 text-right font-mono text-[12px] tnum">{q.threshold.toFixed(2)}</span>
          </div>
        )}

        {q.kind === "noul" && (
          <div className="grid grid-cols-2 gap-1.5">
            <Input value={q.yes} onChange={(yes) => onChange({ yes })} placeholder="“Yes” means… (optional)" />
            <Input value={q.no} onChange={(no) => onChange({ no })} placeholder="“No” means… (optional)" />
          </div>
        )}

        {q.kind === "score" && (
          <div className="space-y-1.5">
            {q.levels.map((l, i) => (
              <div key={i} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-1.5">
                <span className="text-center font-mono text-[11px] text-faint">{i}</span>
                <Input value={l} placeholder="Describe this level" onChange={(v) => onChange({ levels: q.levels.map((x, k) => (k === i ? v : x)) })} />
                <Button variant="ghost" size="icon" disabled={q.levels.length <= 2} onClick={() => onChange({ levels: q.levels.filter((_, k) => k !== i) })} icon={<X className="size-3.5" />} />
              </div>
            ))}
            {q.levels.length < 10 && (
              <Button variant="ghost" size="sm" icon={<Plus className="size-3" />} onClick={() => onChange({ levels: [...q.levels, ""] })}>
                Level
              </Button>
            )}
          </div>
        )}

        {q.kind === "number" && (
          <div className="grid grid-cols-[1fr_7rem] gap-1.5">
            <Input mono value={q.values} onChange={(values) => onChange({ values })} placeholder="Candidate values: 0, 5, 10, 20" />
            <Input value={q.unit} onChange={(unit) => onChange({ unit })} placeholder="unit" />
          </div>
        )}

        <Disclosure label={q.context.trim() ? "Context" : "Add context"} defaultOpen={!!q.context}>
          <Textarea rows={2} value={q.context} onChange={(e) => onChange({ context: e.target.value })} placeholder="Guidance for this question only, e.g. inclusion criteria, edge cases, definitions." />
        </Disclosure>
      </div>
    </div>
  );
}

function headline(a: AnyAnswer): string {
  switch (a.type) {
    case "choice":
      return a.choice;
    case "noul":
      return a.noul >= 0.5 ? "Yes" : "No";
    case "score":
      return a.legend[String(Math.round(a.score))] ?? a.score.toFixed(2);
    case "multi":
      return a.selected.length ? a.selected.join(", ") : "None apply";
    case "rank":
      return a.ranking[0];
    case "number":
      return `${fmt(a.estimate)}${a.unit ? ` ${a.unit}` : ""}`;
  }
}

/** What "agreeing" means per type: same label, same yes/no, same most-likely value, same set. */
function consensusKey(a: AnyAnswer): string {
  switch (a.type) {
    case "number":
      return `${fmt(a.most_likely)}${a.unit ? ` ${a.unit}` : ""}`;
    case "multi":
      return [...a.selected].sort().join(", ") || "None apply";
    case "score":
      return String(Math.round(a.score));
    default:
      return headline(a);
  }
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString());

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

/** An Ollaya/TypeSafe wire question (e.g. from a preset) as an editable draft. */
function fromWire(id: string, q: Question): Omit<QDraft, "key"> {
  const text = typeof q.instructions === "string" && q.instructions.trim() ? q.instructions : id.replace(/_/g, " ");
  const base = { ...blank(), text, context: "" };
  if (q.type === "choice") {
    const criteria = Array.isArray(q.criteria) ? Object.fromEntries((q.criteria as string[]).map((c) => [c, null])) : q.criteria;
    return { ...base, kind: "choice", options: Object.entries(criteria).map(([name, d]) => ({ name, description: typeof d === "string" ? d : "" })) };
  }
  if (q.type === "score") return { ...base, kind: "score", levels: q.criteria.map((c) => (typeof c === "string" ? c : JSON.stringify(c))) };
  return { ...base, kind: "noul", yes: q.criteria?.true ?? "", no: q.criteria?.false ?? "" };
}

// ---- Bulk: many entries × one model ---------------------------------------------------------------

interface BulkRow {
  idx: number;
  input: string;
  answers?: Record<string, AnyAnswer>;
  error?: unknown;
  latency?: number;
  cost?: number;
}

type Source = "paste" | "dataset";

// Results survive navigating away and back within a session (they can be large, so not persisted).
let bulkCache: { rows: BulkRow[]; titles: Record<string, string>; model: string } | null = null;

const SAMPLE_BULK = [
  "I was charged twice this month, please refund the second payment.",
  "The app crashes every time I open the camera.",
  "How do I change the email address on my account?",
  "Cancel my subscription, I found a cheaper alternative.",
].join("\n");

function Bulk({ viewSwitch, questionsSection, built, invalid, shared, setShared }: { viewSwitch: ReactNode; questionsSection: ReactNode; built: { id: string; title: string; q: AnyQuestion | null }[]; invalid: number; shared: string; setShared: (s: string) => void }) {
  const { models, cloudModels, toast, refreshBudget } = useApp();
  const savedBulk = useMemo(() => load<{ source: Source; paste: string; datasetId: string; cols: string[]; limit: string; model: string } | null>("bulk", null), []);
  const [source, setSource] = useState<Source>(savedBulk?.source ?? "paste");
  const [paste, setPaste] = useState(savedBulk?.paste ?? SAMPLE_BULK);
  const [datasetId, setDatasetId] = useState(savedBulk?.datasetId ?? "");
  const [cols, setCols] = useState<string[]>(savedBulk?.cols ?? []);
  const [limit, setLimit] = useState(savedBulk?.limit ?? "100");
  const [model, setModel] = useState(savedBulk?.model ?? "");
  const [rows, setRows] = useState<BulkRow[]>(bulkCache?.rows ?? []);
  const [titles, setTitles] = useState<Record<string, string>>(bulkCache?.titles ?? {});
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const datasets = useAsync(() => api.datasets(), []);
  const ds = datasets.data?.find((d) => d.id === datasetId);

  const modelOptions = [...models.map((m) => ({ value: m.name, label: shortModel(m.name) })), ...cloudModels.map((m) => ({ value: m.id, label: `${m.display_name} (cloud)` }))];
  useEffect(() => {
    if (!model && modelOptions.length) setModel(modelOptions[0].value);
  }, [model, modelOptions]);
  useEffect(() => {
    if (!datasetId && datasets.data?.length) setDatasetId(datasets.data[0].id);
  }, [datasetId, datasets.data]);
  useEffect(() => {
    if (ds && cols.every((c) => !ds.columns.includes(c))) setCols(guessInputColumns(ds.columns, guessLabelColumn(ds.columns)));
  }, [ds, cols]);
  useEffect(() => save("bulk", { source, paste, datasetId, cols, limit, model }), [source, paste, datasetId, cols, limit, model]);
  useEffect(() => {
    bulkCache = { rows, titles, model };
  }, [rows, titles, model]);

  const lines = useMemo(() => paste.split("\n").map((l) => l.trim()).filter(Boolean), [paste]);
  const max = Math.max(1, Math.min(Number(limit) || 100, 10_000));
  const count = source === "paste" ? lines.length : Math.min(max, ds?.row_count ?? 0);
  const canRun = !running && !!model && count > 0 && built.length > 0 && invalid === 0 && (source === "paste" || cols.length > 0);
  const done = rows.filter((r) => r.answers || r.error !== undefined).length;

  const run = async () => {
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
  };

  const exportCsv = async () => {
    const ids = Object.keys(titles);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["row", "input", ...ids.flatMap((id) => [id, `${id}:confidence`])];
    const body = rows.map((r) => [String(r.idx + 1), r.input, ...ids.flatMap((id) => {
      const a = r.answers?.[id];
      return a ? [headline(a), "confidence" in a ? a.confidence.toFixed(3) : a.type === "noul" ? a.noul.toFixed(3) : ""] : [r.error !== undefined ? "error" : "", ""];
    })]);
    const csv = [header, ...body].map((line) => line.map(esc).join(",")).join("\n");
    const path = await pickSavePath("playground-bulk.csv");
    if (!path) return;
    await api.saveTextFile(path, csv);
    toast(`Exported ${rows.length} rows`, "good");
  };

  const totalCost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
  const lat = rows.map((r) => r.latency).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const ids = Object.keys(titles);

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="Bulk: run your questions over many entries with one model. No ground truth needed."
        actions={
          <>
            {viewSwitch}
            <Select className="min-w-[10rem]" value={model} onChange={setModel} options={modelOptions} placeholder="Model…" />
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
                Run on {count.toLocaleString()} {count === 1 ? "entry" : "entries"}
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10">
        <div>
          <Section
            title="Entries"
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
                <Textarea rows={9} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="One entry per line" />
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
                <FormRow label="First rows:" labelWidth={110} hint="Bulk runs the first N rows in order. For a scored, sampled run use an experiment.">
                  <Input className="max-w-[7rem]" value={limit} onChange={setLimit} />
                </FormRow>
              </div>
            )}
            <Disclosure className="mt-3" label={shared.trim() ? "Shared context" : "Add shared context"} defaultOpen={!!shared}>
              <Textarea rows={2} value={shared} onChange={(e) => setShared(e.target.value)} placeholder="Background every question should know." />
            </Disclosure>
          </Section>
        </div>
        <div>{questionsSection}</div>
      </div>

      {rows.length > 0 && (
        <Section
          title="Results"
          subtitle={`${done.toLocaleString()} of ${rows.length.toLocaleString()} done · ${shortModel(model)}${lat.length ? ` · median ${ms(lat[Math.floor(lat.length / 2)])}` : ""}${totalCost ? ` · ${usd(totalCost)}` : ""}`}
        >
          {running && <Progress value={done / rows.length} className="mb-3" />}
          <div className="max-h-[560px] overflow-auto border-y border-border" data-selectable>
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-background text-[11px] text-faint">
                <tr className="border-b border-border">
                  <th className="w-10 py-2 text-left font-medium">#</th>
                  <th className="py-2 pr-3 text-left font-medium">Input</th>
                  {ids.map((id) => (
                    <th key={id} className="max-w-[180px] truncate py-2 pr-3 text-left font-medium" title={titles[id]}>
                      {titles[id]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.idx} className="border-b border-border/60 align-top">
                    <td className="py-1.5 font-mono text-[11px] text-faint tnum">{r.idx + 1}</td>
                    <td className="max-w-[380px] truncate py-1.5 pr-3" title={r.input}>
                      {r.input}
                    </td>
                    {ids.map((id) => {
                      const a = r.answers?.[id];
                      return (
                        <td key={id} className="py-1.5 pr-3">
                          {a ? (
                            <span>
                              {headline(a)}
                              {"confidence" in a && <span className="ml-1 font-mono text-[10.5px] text-faint">{pct(a.confidence, 0)}</span>}
                              {a.type === "noul" && <span className="ml-1 font-mono text-[10.5px] text-faint">{a.noul.toFixed(2)}</span>}
                            </span>
                          ) : r.error !== undefined ? (
                            <span className="text-bad" title={describeError(r.error).message}>
                              error
                            </span>
                          ) : (
                            <span className="text-faint">…</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}
