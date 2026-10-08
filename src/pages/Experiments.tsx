import { FlaskConical, GitCompareArrows, Plus } from "lucide-react";
import { useState } from "react";
import { Button, Checkbox, Empty, ErrorNote, PageHeader, Progress, Spinner, Tooltip } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago, modelColor, shortModel } from "../lib/format";
import { StatusBadge } from "./ExperimentDetail";

export function Experiments() {
  const { go } = useApp();
  const { data, error, loading } = useAsync(() => api.experiments(), []);
  // Up to two rows selected for comparison; picking a third drops the oldest pick.
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setSel((s) => (on ? [...s.filter((x) => x !== id), id].slice(-2) : s.filter((x) => x !== id)));

  return (
    <>
      <PageHeader
        title="Experiments"
        subtitle="Each experiment runs a sample of a dataset through several models and scores them against ground truth."
        actions={
          <>
          {data && data.length > 1 && (
            <Tooltip content={sel.length === 2 ? "Compare the two selected experiments" : "Tick two experiments to compare them"} side="bottom">
              <Button icon={<GitCompareArrows className="size-3.5" />} disabled={sel.length !== 2} onClick={() => go({ page: "compare", a: sel[0], b: sel[1] })}>
                Compare{sel.length ? ` (${sel.length}/2)` : ""}
              </Button>
            </Tooltip>
          )}
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "new-experiment" })}>
            New experiment
          </Button>
          </>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data?.length === 0 && (
        <div>
          <Empty icon={<FlaskConical className="size-5" />} title="No experiments yet" action={<Button variant="primary" onClick={() => go({ page: "datasets" })}>Pick a dataset</Button>}>
            Import a dataset with a label column, then compare models on it.
          </Empty>
        </div>
      )}
      {data && data.length > 0 && (
        <div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-[11.5px] text-faint">
              <tr>
                <th className="w-8 py-2.5" />
                <th className="py-2.5 text-left font-medium">Experiment</th>
                <th className="px-3 py-2.5 text-left font-medium">Dataset</th>
                <th className="px-3 py-2.5 text-left font-medium">Models</th>
                <th className="px-3 py-2.5 text-right font-medium">Rows</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="py-2.5 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => {
                const total = e.row_indices.length * e.config.models.length;
                const done = Object.values(e.progress).reduce((a, b) => a + b, 0);
                return (
                  <tr key={e.id} onClick={() => go({ page: "experiment", id: e.id })} className={`group cursor-pointer border-t border-border hover:bg-sel/50 ${sel.includes(e.id) ? "bg-primary/5" : ""}`}>
                    <td className="py-3 pl-1" onClick={(ev) => ev.stopPropagation()}>
                      <div className={sel.includes(e.id) || sel.length ? "" : "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"}>
                        <Checkbox checked={sel.includes(e.id)} onChange={(on) => toggle(e.id, on)} />
                      </div>
                    </td>
                    <td className="py-3 font-medium">{e.name}</td>
                    <td className="px-3 py-3 text-muted-foreground">{e.dataset_name}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {e.config.models.map((m, i) => (
                          <span key={m} className="flex items-center gap-1 text-[12px] text-muted-foreground">
                            <span className="size-1.5 rounded-full" style={{ background: modelColor(i) }} />
                            {shortModel(m)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-[12px] text-muted-foreground tnum">{e.row_indices.length.toLocaleString()}</td>
                    <td className="px-3 py-3">
                      {e.status === "running" ? <Progress value={done / total} className="w-24" /> : <StatusBadge status={e.status} />}
                    </td>
                    <td className="py-3 text-right text-[12px] text-faint">{ago(e.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
