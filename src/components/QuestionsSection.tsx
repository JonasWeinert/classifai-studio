import { Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { describeError } from "../lib/errors";
import { blank, fromWire, KINDS, newKey, useQuestionDraft, type Kind, type QDraft } from "../lib/questionDraft";
import { Button, Disclosure, FormRow, Input, Modal, Section, Select, Slider, Textarea } from "./ui";

/** The question list with Load… (question sets and Ollaya presets) and Save — same in Playground and Bulk. */
export function QuestionsSection() {
  const { engine, toast } = useApp();
  const d = useQuestionDraft();
  const [saving, setSaving] = useState(false);
  const sets = useAsync(() => api.questionSets(), []);
  const presets = useAsync(() => (engine?.running ? api.presets() : Promise.resolve([])), [engine?.running]);

  // Presets load as editable questions, so they work with every model (cloud included).
  const loadSource = async (value: string) => {
    if (value.startsWith("preset:")) {
      const name = value.slice(7);
      try {
        const questions = await api.presetShow(name);
        d.setQs(Object.entries(questions).map(([id, q]) => ({ ...fromWire(id, q), key: newKey() })));
        d.setSet(null);
        toast(`Loaded preset “${name}” as editable questions`, "good");
      } catch (e) {
        toast(describeError(e).message, "bad");
      }
      return;
    }
    const q = await api.questionSet(value);
    d.setShared(q.payload.context ?? "");
    d.setQs(q.payload.questions.map((x) => ({ ...x, key: newKey() })));
    d.setSet({ id: q.id, name: q.name, version: q.version });
  };
  const options = [
    ...(sets.data ?? []).map((x) => ({ value: x.id, label: `${x.name} · v${x.version}` })),
    ...(presets.data ?? []).map((p) => ({ value: `preset:${p.name}`, label: `Preset: ${p.name}` })),
  ];

  return (
    <Section
      title="Questions"
      subtitle={d.set ? `From “${d.set.name}” · v${d.set.version}` : "All questions are answered in a single pass per model."}
      actions={
        <div className="flex items-center gap-2">
          <Select className="min-w-[10rem]" placeholder="Load…" value={d.set?.id ?? ""} onChange={loadSource} options={options} />
          <Button size="sm" icon={<Save className="size-3" />} onClick={() => setSaving(true)}>
            {d.set ? "Save" : "Save as set"}
          </Button>
        </div>
      }
    >
      <div className="divide-y divide-border">
        {d.qs.map((q, i) => (
          <QuestionEditor key={q.key} q={q} index={i} id={d.built[i]?.id} invalid={!d.built[i]?.q} onChange={(p) => d.update(q.key, p)} onRemove={d.qs.length > 1 ? () => d.setQs(d.qs.filter((x) => x.key !== q.key)) : undefined} />
        ))}
        <div className="pt-3">
          <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => d.setQs([...d.qs, blank()])}>
            Add question
          </Button>
        </div>
      </div>
      <SaveSetSheet
        open={saving}
        onClose={() => setSaving(false)}
        current={d.set}
        onSave={async (name, description, asNew) => {
          const summary = await api.questionSetSave({ id: asNew ? null : d.set?.id, name, description, payload: { context: d.shared, questions: d.qs.map(({ key: _k, ...q }) => q) } });
          d.setSet({ id: summary.id, name: summary.name, version: summary.version });
          sets.reload();
          toast(`Saved “${summary.name}” · v${summary.version}`, "good");
        }}
      />
    </Section>
  );
}

/** Shared-context disclosure under an input area. */
export function SharedContext() {
  const d = useQuestionDraft();
  return (
    <Disclosure className="mt-3" label={d.shared.trim() ? "Shared context" : "Add shared context"} defaultOpen={!!d.shared}>
      <Textarea rows={2} value={d.shared} onChange={(e) => d.setShared(e.target.value)} placeholder="Background every question should know, e.g. “Messages are from customers of a German telecom.”" />
    </Disclosure>
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
