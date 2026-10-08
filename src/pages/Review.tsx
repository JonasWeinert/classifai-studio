// C4: a screening / adjudication queue — one row at a time, decided with the keyboard.
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ListChecks } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, ErrorNote, Input, Kbd, PageHeader, Progress, Segmented, Select, Slider, Spinner, Tooltip } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app";
import { modelColor, pct, shortModel } from "../lib/format";
import type { Experiment, Page, PredictionRow, ReviewStrategy } from "../lib/types";

const LIMIT = 500;

export function Review({ id, question }: { id: string; question?: string }) {
  const { go, toast } = useApp();
  const [exp, setExp] = useState<Experiment | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState<string | undefined>(question);
  const [strategy, setStrategy] = useState<ReviewStrategy>("disagree");
  const [conf, setConf] = useState(0.6);
  const [confQuery, setConfQuery] = useState(0.6);
  const [queue, setQueue] = useState<Page<PredictionRow> | null>(null);
  const [idx, setIdx] = useState(0);
  const [decided, setDecided] = useState<Record<number, { value: string; confirmed: boolean }>>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .experiment(id)
      .then((e) => {
        setExp(e);
        setQ((cur) => cur ?? e.config.tasks[0]?.id);
      })
      .catch(setError);
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => setConfQuery(conf), 300);
    return () => clearTimeout(t);
  }, [conf]);

  useEffect(() => {
    if (!q) return;
    let live = true;
    setQueue(null);
    api
      .reviewQueue(id, q, strategy, 0, LIMIT, strategy === "low_confidence" ? confQuery : undefined)
      .then((p) => {
        if (!live) return;
        setQueue(p);
        setDecided({});
        const first = p.rows.findIndex((r) => !r.corrected);
        setIdx(first >= 0 ? first : 0);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [id, q, strategy, confQuery]);

  const task = exp?.config.tasks.find((t) => t.id === q);
  const rows = queue?.rows ?? [];
  const row: PredictionRow | undefined = rows[idx];
  const isDone = (r: PredictionRow) => !!r.corrected || !!decided[r.row_idx];
  const reviewed = rows.filter(isDone).length;
  const current = row ? decided[row.row_idx]?.value ?? row.ground_truth : "";

  useEffect(() => {
    setNote(row?.review_note ?? "");
  }, [row?.row_idx, row?.review_note]);

  const advance = useCallback(
    (from: number, justDecided?: number) => {
      const done = (r: PredictionRow) => r.row_idx === justDecided || isDone(r);
      const next = rows.findIndex((r, i) => i > from && !done(r));
      if (next >= 0) return setIdx(next);
      const wrap = rows.findIndex((r) => !done(r));
      setIdx(wrap >= 0 ? wrap : rows.length);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, decided],
  );

  const decide = useCallback(
    async (value: string) => {
      if (!row || !task || !exp || saving) return;
      setSaving(true);
      try {
        await api.setCorrection(exp.dataset_id, row.row_idx, task.label_column, value, note.trim() || null);
        const original = row.original_ground_truth ?? row.ground_truth;
        setDecided((d) => ({ ...d, [row.row_idx]: { value, confirmed: value === original } }));
        advance(idx, row.row_idx);
      } catch (e) {
        toast(errorMessage(e), "bad");
      } finally {
        setSaving(false);
      }
    },
    [row, task, exp, saving, note, advance, idx, toast],
  );

  const skip = useCallback(() => setIdx((i) => Math.min(rows.length, i + 1)), [rows.length]);
  const back = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  // Keyboard: 1–9 pick a label, Enter confirms the ground truth, → skips, ← goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!row || !task || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, [contenteditable=true]");
      if (e.key === "Enter" && !e.shiftKey) {
        if (t?.closest("button")) return;
        e.preventDefault();
        decide(row.ground_truth);
        return;
      }
      if (typing) return;
      if (/^[1-9]$/.test(e.key)) {
        const l = task.labels[Number(e.key) - 1];
        if (l) {
          e.preventDefault();
          decide(l.value);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skip();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, task, decide, skip, back]);

  const parsed = useMemo(() => {
    if (!row?.input.startsWith("{")) return null;
    try {
      return Object.entries(JSON.parse(row.input) as Record<string, string>);
    } catch {
      return null;
    }
  }, [row?.input]);

  if (error != null && !exp) return <ErrorNote error={error} />;
  if (!exp) return <Spinner />;
  const color = (m: string) => modelColor(exp.config.models.indexOf(m));
  const strategyText: Record<ReviewStrategy, string> = {
    disagree: "Rows where the models disagree with each other.",
    low_confidence: `Rows where a model's confidence is below ${pct(confQuery, 0)}.`,
    wrong: "Rows where at least one model disagrees with the ground truth.",
  };

  return (
    <>
      <PageHeader
        back={{ label: exp.name, onClick: () => go({ page: "experiment", id }) }}
        title="Review"
        subtitle={`${exp.name}${task ? ` · ${task.label_column}` : ""} — decisions are saved as ground-truth corrections on ${exp.dataset_name}`}
        actions={
          queue && (
            <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
              <span className="tnum">
                <b className="text-foreground">{reviewed}</b> of {rows.length.toLocaleString()} reviewed
              </span>
              <Progress value={rows.length ? reviewed / rows.length : 0} className="w-28" />
            </div>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-border pb-5">
        {exp.config.tasks.length > 1 && <Select value={q ?? ""} onChange={setQ} options={exp.config.tasks.map((t) => ({ value: t.id, label: t.label_column }))} />}
        <Segmented
          value={strategy}
          onChange={setStrategy}
          options={[
            { value: "disagree", label: "Disagreements" },
            { value: "low_confidence", label: "Low confidence" },
            { value: "wrong", label: "Any wrong" },
          ]}
        />
        {strategy === "low_confidence" && (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span>below</span>
            <Slider value={conf} onChange={setConf} min={0.05} max={0.95} step={0.05} className="w-36" />
            <span className="w-9 font-mono text-foreground tnum">{pct(conf, 0)}</span>
          </div>
        )}
        <span className="text-[12px] text-faint">{strategyText[strategy]}</span>
      </div>

      {!queue || !task ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty icon={<ListChecks />} title="Nothing to review">
          No rows match this queue. Try another strategy{strategy === "low_confidence" ? " or raise the confidence cut-off" : ""}.
        </Empty>
      ) : !row ? (
        <Empty
          icon={<CheckCircle2 />}
          title={`All ${rows.length.toLocaleString()} rows reviewed`}
          action={
            <div className="flex gap-2">
              <Button onClick={() => setIdx(0)}>Go through again</Button>
              <Button variant="primary" onClick={() => go({ page: "experiment", id })}>
                Back to results
              </Button>
            </div>
          }
        >
          Metrics on {exp.dataset_name} now use your corrections.
          {queue.total > rows.length && ` This queue had ${queue.total.toLocaleString()} rows; the first ${rows.length} were shown.`}
        </Empty>
      ) : (
        <div key={row.row_idx} className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-10 fade-up">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-mono tnum">Row {row.row_idx + 1}</span>
              <span className="text-faint">·</span>
              <span className="tnum">
                {idx + 1} of {rows.length}
              </span>
              {isDone(row) && (
                <Badge tone={decided[row.row_idx] ? (decided[row.row_idx].confirmed ? "good" : "accent") : "good"}>
                  {decided[row.row_idx] ? (decided[row.row_idx].confirmed ? "confirmed" : `relabelled → ${decided[row.row_idx].value}`) : "already reviewed"}
                </Badge>
              )}
            </div>
            <div className="max-h-[46vh] overflow-auto text-[15px] leading-relaxed" data-selectable>
              {parsed ? (
                <dl className="space-y-3">
                  {parsed.map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-mono text-[11.5px] text-faint">{k}</dt>
                      <dd className="whitespace-pre-wrap">{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="whitespace-pre-wrap">{row.input}</p>
              )}
            </div>

            <div className="mt-7 border-t border-border pt-5">
              <div className="mb-2 text-[12px] font-medium text-muted-foreground">
                What is the right “{task.label_column}”? <span className="font-normal text-faint">Press a number, or Enter to keep “{row.ground_truth}”.</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((l, i) => {
                  const isGt = l.value === row.ground_truth;
                  const chosen = l.value === current && isDone(row);
                  return (
                    <Button key={l.value} variant={isGt ? "primary" : "secondary"} disabled={saving} onClick={() => decide(l.value)} className={clsx(chosen && !isGt && "ring-2 ring-primary")}>
                      {i < 9 && <kbd className={clsx("rounded-[4px] px-1 py-px font-sans text-[11px]", isGt ? "bg-white/25 text-white" : "bg-sel text-muted-foreground")}>{i + 1}</kbd>}
                      {l.value}
                      {isGt && <span className="text-[11.5px] opacity-80">· keep ↵</span>}
                    </Button>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Input value={note} onChange={setNote} placeholder="Note (optional) — e.g. a reason for exclusion or a coding rule" className="flex-1" />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Tooltip content="Previous row (←)">
                  <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-3.5" />} disabled={idx === 0} onClick={back}>
                    Back
                  </Button>
                </Tooltip>
                <Tooltip content="Leave this row for later (→)">
                  <Button variant="ghost" size="sm" onClick={skip}>
                    Skip <ArrowRight className="size-3.5" />
                  </Button>
                </Tooltip>
                <div className="flex-1" />
                <Button variant="primary" loading={saving} icon={<Check className="size-3.5" />} onClick={() => decide(row.ground_truth)}>
                  Confirm ground truth
                </Button>
              </div>
            </div>
          </div>

          <aside className="space-y-5">
            <div>
              <div className="mb-1 text-[11.5px] font-medium text-faint">Ground truth</div>
              <div className="text-[18px] font-semibold tracking-[-0.01em]">{current}</div>
              {row.corrected && row.original_ground_truth && row.original_ground_truth !== row.ground_truth && (
                <div className="text-[12px] text-muted-foreground">
                  originally <span className="line-through">{row.original_ground_truth}</span>
                </div>
              )}
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-medium text-faint">Models said</div>
              <div className="space-y-2.5">
                {exp.config.models.map((m) => {
                  const c = row.by_model[m];
                  const agrees = c?.predicted === row.ground_truth;
                  return (
                    <div key={m}>
                      <div className="flex items-center justify-between gap-2 text-[12.5px]">
                        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                          <span className="size-2 shrink-0 rounded-full" style={{ background: color(m) }} />
                          <span className="truncate">{shortModel(m)}</span>
                        </span>
                        <span className={clsx("font-medium", c?.predicted ? (agrees ? "text-good" : "text-bad") : "text-faint")}>{c?.predicted ?? c?.error ?? "—"}</span>
                      </div>
                      {c?.confidence != null && (
                        <div className="mt-1 flex items-center gap-2">
                          <Progress value={c.confidence} color={color(m)} className="flex-1" />
                          <span className="w-9 text-right font-mono text-[11.5px] text-muted-foreground tnum">{pct(c.confidence, 0)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border-t border-border pt-3 text-[11.5px] leading-relaxed text-faint">
              <Kbd>1</Kbd>–<Kbd>9</Kbd> label · <Kbd>↵</Kbd> confirm · <Kbd>→</Kbd> skip · <Kbd>←</Kbd> back
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
