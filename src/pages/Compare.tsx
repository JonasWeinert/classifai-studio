// R1: compare two experiments — per question and model, metric deltas; per label, F1 deltas.
import clsx from "clsx";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Empty, ErrorNote, PageHeader, Section, Segmented, Select, Spinner, Tooltip } from "../components/ui";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { modelColor, num, pct, shortModel, usd } from "../lib/format";
import type { Experiment, ModelMetrics, Report, TaskSpec, UsageRow } from "../lib/types";

interface Side {
  exp: Experiment;
  reports: Record<string, Report>;
  usage: Record<string, UsageRow>;
}

async function loadSide(exp: Experiment, questions: string[]): Promise<Side> {
  const [reports, usage] = await Promise.all([
    Promise.all(questions.map((q) => api.report(exp.id, q))),
    api.experimentUsage(exp.id).catch(() => [] as UsageRow[]),
  ]);
  return { exp, reports: Object.fromEntries(reports.map((r, i) => [questions[i], r])), usage: Object.fromEntries(usage.map((u) => [u.model, u])) };
}

const scoredModel = (r: Report | undefined, m: string) => {
  const x = r?.models.find((y) => y.model === m);
  return x && x.evaluated - x.errors > 0 ? x : null;
};

export function Compare({ a, b }: { a: string; b?: string }) {
  const { go } = useApp();
  const [all, setAll] = useState<Experiment[] | null>(null);
  const [aId, setAId] = useState(a);
  const [bId, setBId] = useState<string | undefined>(b);
  const [sides, setSides] = useState<[Side, Side] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .experiments()
      .then((list) => setAll([...list].sort((x, y) => y.created_at.localeCompare(x.created_at))))
      .catch(setError);
  }, []);

  const expA = all?.find((e) => e.id === aId);
  // Default B: the most recent other experiment on the same dataset, else the most recent other one.
  useEffect(() => {
    if (!all || !expA || (bId && bId !== aId && all.some((e) => e.id === bId))) return;
    const others = all.filter((e) => e.id !== aId);
    setBId((others.find((e) => e.dataset_id === expA.dataset_id) ?? others[0])?.id);
  }, [all, expA, aId, bId]);
  const expB = all?.find((e) => e.id === bId);

  const shared: TaskSpec[] = useMemo(() => (expA && expB ? expA.config.tasks.filter((t) => expB.config.tasks.some((u) => u.id === t.id)) : []), [expA, expB]);

  useEffect(() => {
    if (!expA || !expB) return;
    let live = true;
    setSides(null);
    const qs = shared.map((t) => t.id);
    Promise.all([loadSide(expA, qs), loadSide(expB, qs)])
      .then((s) => live && setSides(s))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [expA, expB, shared]);

  if (error != null) return <ErrorNote error={error} />;
  if (!all) return <Spinner />;
  if (!expA) return <ErrorNote>Experiment not found.</ErrorNote>;

  const options = (exclude: string | undefined) =>
    all.filter((e) => e.id !== exclude).map((e) => ({ value: e.id, label: `${e.name}${e.dataset_id !== expA.dataset_id ? ` · ${e.dataset_name}` : ""}` }));
  const models = expB ? expA.config.models.filter((m) => expB.config.models.includes(m)) : [];
  const color = (m: string) => modelColor(expA.config.models.indexOf(m));

  return (
    <>
      <PageHeader
        back={{ label: expA.name, onClick: () => go({ page: "experiment", id: aId }) }}
        title="Compare"
        subtitle="Changes from A to B. Green means B is better."
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-muted-foreground">A</span>
            <Select className="w-60" value={aId} onChange={setAId} options={options(bId)} />
            <Tooltip content="Swap A and B" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                disabled={!bId}
                icon={<ArrowLeftRight className="size-3.5" />}
                onClick={() => {
                  if (!bId) return;
                  setAId(bId);
                  setBId(aId);
                }}
              />
            </Tooltip>
            <span className="text-[12px] font-semibold text-muted-foreground">B</span>
            <Select className="w-60" value={bId ?? ""} placeholder="Pick an experiment…" onChange={setBId} options={options(aId)} />
          </div>
        }
      />

      {!expB ? (
        <Empty icon={<GitCompareArrows />} title="Nothing to compare yet">
          Duplicate this experiment, change the wording or the models, and run it — then compare the two here.
        </Empty>
      ) : (
        <>
          {expA.dataset_id !== expB.dataset_id && (
            <div className="mb-4 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
              These experiments use different datasets ({expA.dataset_name} vs {expB.dataset_name}), so differences mix data and setup.
            </div>
          )}
          <ConfigDiff a={expA} b={expB} />
          {shared.length === 0 ? (
            <Empty icon={<GitCompareArrows />} title="No questions in common">
              The two experiments share no question ids, so there's nothing to compare metric by metric.
            </Empty>
          ) : models.length === 0 ? (
            <Empty icon={<GitCompareArrows />} title="No models in common">
              A and B were run with different models.
            </Empty>
          ) : !sides ? (
            <Spinner />
          ) : (
            <>
              <Overview sides={sides} shared={shared} models={models} color={color} />
              {shared.map((t) => (
                <QuestionCompare key={t.id} task={t} taskB={expB.config.tasks.find((u) => u.id === t.id)!} a={sides[0].reports[t.id]} b={sides[1].reports[t.id]} models={models} color={color} />
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Δ with sign and colour. `low` = lower is better. */
function Delta({ v, fmt, low, eps = 0.0005 }: { v: number | null; fmt: (x: number) => string; low?: boolean; eps?: number }) {
  if (v === null) return <span className="text-faint">—</span>;
  if (Math.abs(v) < eps) return <span className="text-faint">±0</span>;
  const better = low ? v < 0 : v > 0;
  return <span className={clsx("font-medium", better ? "text-good" : "text-bad")}>{`${v > 0 ? "+" : "−"}${fmt(Math.abs(v))}`}</span>;
}

const pts = (v: number) => `${(v * 100).toFixed(1)} pts`;

function ConfigDiff({ a, b }: { a: Experiment; b: Experiment }) {
  const diffs: { what: string; a: string; b: string }[] = [];
  if ((a.config.context ?? "") !== (b.config.context ?? "")) diffs.push({ what: "Shared context", a: a.config.context || "—", b: b.config.context || "—" });
  if (a.config.input_columns.join() !== b.config.input_columns.join()) diffs.push({ what: "Input columns", a: a.config.input_columns.join(" + "), b: b.config.input_columns.join(" + ") });
  if (a.row_indices.length !== b.row_indices.length) diffs.push({ what: "Rows", a: a.row_indices.length.toLocaleString(), b: b.row_indices.length.toLocaleString() });
  const ma = a.config.models.map(shortModel).join(", "),
    mb = b.config.models.map(shortModel).join(", ");
  if (ma !== mb) diffs.push({ what: "Models", a: ma, b: mb });
  for (const t of a.config.tasks) {
    const u = b.config.tasks.find((x) => x.id === t.id);
    if (!u) continue;
    if (t.instructions !== u.instructions) diffs.push({ what: `${t.label_column} · wording`, a: t.instructions, b: u.instructions });
    if ((t.context ?? "") !== (u.context ?? "")) diffs.push({ what: `${t.label_column} · context`, a: t.context || "—", b: u.context || "—" });
    const la = t.labels.map((l) => `${l.value}${l.description ? `: ${l.description}` : ""}`).join("; "),
      lb = u.labels.map((l) => `${l.value}${l.description ? `: ${l.description}` : ""}`).join("; ");
    if (la !== lb) diffs.push({ what: `${t.label_column} · labels`, a: la, b: lb });
    if ((t.threshold ?? 0.5) !== (u.threshold ?? 0.5)) diffs.push({ what: `${t.label_column} · threshold`, a: (t.threshold ?? 0.5).toFixed(2), b: (u.threshold ?? 0.5).toFixed(2) });
  }
  return (
    <Section title="What changed" subtitle={diffs.length ? undefined : "The setups are identical — differences come from randomness or model versions."}>
      {diffs.length > 0 && (
        <table className="w-full text-[12.5px]">
          <thead className="text-[11.5px] text-faint">
            <tr>
              <th className="w-44 py-1 text-left font-medium" />
              <th className="py-1 pr-4 text-left font-medium">A · {a.name}</th>
              <th className="py-1 text-left font-medium">B · {b.name}</th>
            </tr>
          </thead>
          <tbody>
            {diffs.map((d) => (
              <tr key={d.what} className="border-t border-border align-top">
                <td className="py-1.5 pr-3 text-muted-foreground">{d.what}</td>
                <td className="py-1.5 pr-4 text-muted-foreground">{d.a}</td>
                <td className="py-1.5">{d.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Overview({ sides, shared, models, color }: { sides: [Side, Side]; shared: TaskSpec[]; models: string[]; color: (m: string) => string }) {
  const [A, B] = sides;
  const meanF1 = (s: Side, m: string) => {
    const v = shared.map((t) => scoredModel(s.reports[t.id], m)?.macro_f1).filter((x): x is number => x != null);
    return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null;
  };
  const anyCost = models.some((m) => (A.usage[m]?.cost_usd ?? 0) > 0 || (B.usage[m]?.cost_usd ?? 0) > 0);
  return (
    <Section title="Overall" subtitle={`Mean macro F1 over ${shared.length} shared question${shared.length === 1 ? "" : "s"}${anyCost ? ", and what each run cost" : ""}.`}>
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-[11.5px] text-faint">
          <tr>
            <th className="py-2 pr-3 text-left font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Macro F1 A</th>
            <th className="px-3 py-2 text-right font-medium">Macro F1 B</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
            {anyCost && (
              <>
                <th className="px-3 py-2 text-right font-medium">Cost A</th>
                <th className="px-3 py-2 text-right font-medium">Cost B</th>
                <th className="py-2 pl-3 text-right font-medium">Δ cost</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const fa = meanF1(A, m),
              fb = meanF1(B, m);
            const ca = A.usage[m]?.cost_usd ?? 0,
              cb = B.usage[m]?.cost_usd ?? 0;
            return (
              <tr key={m} className="border-t border-border">
                <ModelCell m={m} color={color} />
                <td className="px-3 py-2.5 text-right font-mono text-[12.5px] text-muted-foreground tnum">{fa == null ? "—" : num(fa)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-[12.5px] tnum">{fb == null ? "—" : num(fb)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-[12.5px] tnum">
                  <Delta v={fa != null && fb != null ? fb - fa : null} fmt={pts} />
                </td>
                {anyCost && (
                  <>
                    <td className="px-3 py-2.5 text-right font-mono text-[12.5px] text-muted-foreground tnum">{usd(ca)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12.5px] tnum">{usd(cb)}</td>
                    <td className="py-2.5 pl-3 text-right font-mono text-[12.5px] tnum">
                      <Delta v={cb - ca} fmt={usd} low eps={0.00005} />
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function ModelCell({ m, color }: { m: string; color: (m: string) => string }) {
  return (
    <td className="py-2.5 pr-3">
      <span className="flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ background: color(m) }} />
        <span className="font-medium">{shortModel(m)}</span>
      </span>
    </td>
  );
}

function QuestionCompare({ task, taskB, a, b, models, color }: { task: TaskSpec; taskB: TaskSpec; a: Report; b: Report; models: string[]; color: (m: string) => string }) {
  const [model, setModel] = useState(models[0]);
  const metrics: { key: string; label: string; f: (m: ModelMetrics) => number; fmt: (v: number) => string; dfmt: (v: number) => string }[] = [
    { key: "f1", label: "Macro F1", f: (m) => m.macro_f1, fmt: (v) => num(v), dfmt: pts },
    { key: "acc", label: "Accuracy", f: (m) => m.accuracy, fmt: (v) => pct(v), dfmt: pts },
    { key: "kappa", label: "κ", f: (m) => m.kappa, fmt: (v) => num(v), dfmt: (v) => num(v) },
  ];
  const ma = scoredModel(a, model),
    mb = scoredModel(b, model);
  const labels = [...new Set([...a.labels, ...b.labels])];

  return (
    <Section
      title={
        <span>
          {task.label_column} <span className="font-normal text-muted-foreground">· {task.kind === "binary" ? "yes/no" : `${task.labels.length} labels`}</span>
        </span>
      }
      subtitle={task.instructions === taskB.instructions ? `“${task.instructions}”` : `Wording changed: “${task.instructions}” → “${taskB.instructions}”`}
    >
      <table className="w-full text-[13px]">
        <thead className="border-b border-border text-[11.5px] text-faint">
          <tr>
            <th className="py-2 pr-3 text-left font-medium">Model</th>
            {metrics.map((c) => (
              <th key={c.key} colSpan={2} className="px-3 py-2 text-right font-medium">
                {c.label} <span className="font-normal">B · Δ</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const x = scoredModel(a, m),
              y = scoredModel(b, m);
            return (
              <tr key={m} className="border-t border-border">
                <ModelCell m={m} color={color} />
                {metrics.map((c) => (
                  <MetricPair key={c.key} b={y ? c.fmt(c.f(y)) : "—"} a={x ? c.fmt(c.f(x)) : "—"} delta={x && y ? c.f(y) - c.f(x) : null} dfmt={c.dfmt} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-[12.5px] font-semibold">Per label F1</div>
          {models.length > 1 && <Segmented value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: shortModel(m) }))} />}
        </div>
        {!ma || !mb ? (
          <div className="py-4 text-[12.5px] text-muted-foreground">No scored predictions for {shortModel(model)} in both runs.</div>
        ) : (
          <table className="w-full max-w-2xl text-[12.5px]">
            <thead className="text-[11.5px] text-faint">
              <tr>
                <th className="py-1 text-left font-medium">Label</th>
                <th className="py-1 text-right font-medium">n</th>
                <th className="py-1 text-right font-medium">F1 A</th>
                <th className="py-1 text-right font-medium">F1 B</th>
                <th className="w-48 py-1 pl-4 text-left font-medium">Δ</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => {
                const ca = ma.per_class.find((c) => c.label === l),
                  cb = mb.per_class.find((c) => c.label === l);
                const d = ca && cb ? cb.f1 - ca.f1 : null;
                return (
                  <tr key={l} className="border-t border-border">
                    <td className="max-w-[200px] truncate py-1.5" title={l}>
                      {l}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] text-faint tnum">{cb?.support ?? ca?.support ?? "—"}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] text-muted-foreground tnum">{ca ? num(ca.f1, 2) : "—"}</td>
                    <td className="py-1.5 text-right font-mono text-[11.5px] tnum">{cb ? num(cb.f1, 2) : "—"}</td>
                    <td className="py-1.5 pl-4">
                      <DeltaBar v={d} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

function MetricPair({ a, b, delta, dfmt }: { a: string; b: string; delta: number | null; dfmt: (v: number) => string }) {
  return (
    <>
      <td className="py-2.5 pl-3 text-right font-mono text-[12.5px] tnum">
        <Tooltip content={`A: ${a} → B: ${b}`}>
          <span>{b}</span>
        </Tooltip>
      </td>
      <td className="w-20 py-2.5 pr-3 pl-2 text-right font-mono text-[12px] tnum">
        <Delta v={delta} fmt={dfmt} />
      </td>
    </>
  );
}

/** Diverging bar around zero, ±0.5 F1 full scale. */
function DeltaBar({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint">—</span>;
  const w = Math.min(1, Math.abs(v) / 0.5) * 50;
  const good = v >= 0;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-28 rounded-full bg-card">
        <div className="absolute top-0 left-1/2 h-full w-px bg-border-strong" />
        <div className={clsx("absolute top-0 h-full rounded-full", good ? "bg-good" : "bg-bad")} style={good ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
      </div>
      <span className="w-12 font-mono text-[11.5px] tnum">
        <Delta v={v} fmt={(x) => x.toFixed(2)} eps={0.005} />
      </span>
    </div>
  );
}
