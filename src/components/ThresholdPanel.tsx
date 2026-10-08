// R4: tune the yes/no decision threshold of a binary question from its precision / recall curve.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { num, shortModel } from "../lib/format";
import type { ThresholdCurve } from "../lib/types";
import { ThresholdChart } from "./charts";
import { Button, ErrorNote, Section, Segmented, Slider, Spinner, Stat } from "./ui";

export function ThresholdPanel({
  experimentId,
  question,
  positive,
  models,
  onApplied,
}: {
  experimentId: string;
  question: string;
  positive: string;
  models: string[];
  onApplied: () => void;
}) {
  const [model, setModel] = useState(models[0]);
  const [curve, setCurve] = useState<ThresholdCurve | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [value, setValue] = useState(0.5);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0]);
  }, [models, model]);

  useEffect(() => {
    if (!model) return;
    let live = true;
    setCurve(null);
    api
      .thresholdCurve(experimentId, question, model)
      .then((c) => {
        if (!live) return;
        setCurve(c);
        setValue(c.current);
        setError(null);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [experimentId, question, model]);

  const at = useMemo(() => {
    if (!curve?.points.length) return null;
    return curve.points.reduce((a, b) => (Math.abs(b.threshold - value) < Math.abs(a.threshold - value) ? b : a));
  }, [curve, value]);
  const atCurrent = useMemo(() => {
    if (!curve?.points.length) return null;
    return curve.points.reduce((a, b) => (Math.abs(b.threshold - curve.current) < Math.abs(a.threshold - curve.current) ? b : a));
  }, [curve]);

  const maxF1 = () => curve && setValue(curve.points.reduce((a, b) => (b.f1 > a.f1 ? b : a)).threshold);
  // Screening: the highest threshold that still finds ≥ 95% of positives (best precision at that recall).
  const recall95 = () => {
    if (!curve) return;
    const ok = curve.points.filter((p) => p.recall >= 0.95);
    setValue(ok.length ? Math.max(...ok.map((p) => p.threshold)) : Math.min(...curve.points.map((p) => p.threshold)));
  };

  const apply = async () => {
    setBusy(true);
    try {
      const t = Math.round(value * 100) / 100;
      await api.setThreshold(experimentId, question, t);
      setCurve((c) => (c ? { ...c, current: t } : c));
      onApplied();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const changed = curve && Math.abs(value - curve.current) > 0.004;
  const delta = (k: "precision" | "recall" | "f1") => (at && atCurrent && changed ? at[k] - atCurrent[k] : null);

  return (
    <Section
      title="Decision threshold"
      subtitle={`A row counts as “${positive}” when P(yes) is at least the threshold. Lower it to miss fewer positives, raise it for fewer false alarms.`}
      actions={models.length > 1 && <Segmented value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: shortModel(m) }))} />}
      className="mt-8"
    >
      {error != null && <ErrorNote error={error} />}
      {!curve && error == null && <Spinner />}
      {curve && at && (
        <div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-10 fade-up">
          <ThresholdChart points={curve.points} value={value} current={curve.current} onPick={setValue} />
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                <span className="text-muted-foreground">Threshold</span>
                <span className="font-mono text-[13px] font-semibold tnum">{value.toFixed(2)}</span>
              </div>
              <Slider value={value} onChange={setValue} min={0.01} max={0.99} step={0.01} />
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" onClick={maxF1}>
                  Max F1
                </Button>
                <Button size="sm" onClick={recall95}>
                  Recall ≥ 95%
                </Button>
                <Button size="sm" variant="ghost" disabled={!changed} onClick={() => setValue(curve.current)}>
                  Reset
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Precision" value={num(at.precision, 2)} sub={<Delta v={delta("precision")} />} />
              <Stat label="Recall" value={num(at.recall, 2)} sub={<Delta v={delta("recall")} />} />
              <Stat label="F1" value={num(at.f1, 2)} sub={<Delta v={delta("f1")} />} />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-[12px] text-muted-foreground">
                Stored: <span className="font-mono tnum">{curve.current.toFixed(2)}</span>
              </span>
              <Button variant="primary" size="sm" disabled={!changed} loading={busy} onClick={apply}>
                Apply {value.toFixed(2)}
              </Button>
            </div>
            <div className="text-[11.5px] text-faint">Applies to every model for this question and recomputes the metrics.</div>
          </div>
        </div>
      )}
    </Section>
  );
}

function Delta({ v }: { v: number | null }) {
  if (v === null || Math.abs(v) < 0.005) return <span className="text-faint">—</span>;
  return <span className={v > 0 ? "text-good" : "text-bad"}>{`${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`}</span>;
}
