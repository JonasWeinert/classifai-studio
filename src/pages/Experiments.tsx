import { FlaskConical, GitCompareArrows, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Checkbox, compareValues, Empty, ErrorNote, PageHeader, Progress, SearchField, Select, SortTh, Spinner, Tooltip, type SortState } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago, modelColor, shortModel } from "../lib/format";
import type { Experiment, ExperimentStatus } from "../lib/types";
import { StatusBadge } from "./ExperimentDetail";

type Key = "name" | "dataset" | "models" | "rows" | "status" | "created";

const STATUS_LABEL: Record<ExperimentStatus, string> = { pending: "Pending", running: "Running", completed: "Completed", cancelled: "Stopped", failed: "Failed" };

const sortValue = (e: Experiment, k: Key): string | number => {
  switch (k) {
    case "name":
      return e.name;
    case "dataset":
      return e.dataset_name;
    case "models":
      return e.config.models.length;
    case "rows":
      return e.row_indices.length;
    case "status":
      return STATUS_LABEL[e.status];
    case "created":
      return e.created_at;
  }
};

/** Evaluations: each scores several models on a dataset sample against its ground truth. */
export function Experiments() {
  const { go } = useApp();
  const { data, error, loading } = useAsync(() => api.experiments(), []);
  // Up to two rows selected for comparison; picking a third drops the oldest pick.
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setSel((s) => (on ? [...s.filter((x) => x !== id), id].slice(-2) : s.filter((x) => x !== id)));
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [dataset, setDataset] = useState("");
  const [model, setModel] = useState("");
  const [sort, setSort] = useState<SortState<Key>>({ key: "created", desc: true });

  const all = data ?? [];
  const datasets = [...new Map(all.map((e) => [e.dataset_id, e.dataset_name])).entries()];
  const models = [...new Set(all.flatMap((e) => e.config.models))];
  const statuses = [...new Set(all.map((e) => e.status))];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = all.filter(
      (e) =>
        (!status || e.status === status) &&
        (!dataset || e.dataset_id === dataset) &&
        (!model || e.config.models.includes(model)) &&
        (!q || [e.name, e.dataset_name, ...e.config.models, ...e.config.tasks.map((t) => t.id)].some((s) => s.toLowerCase().includes(q))),
    );
    if (sort) out.sort((a, b) => compareValues(sortValue(a, sort.key), sortValue(b, sort.key)) * (sort.desc ? -1 : 1));
    return out;
  }, [all, search, status, dataset, model, sort]);
  const filtered = !!(search || status || dataset || model);

  return (
    <>
      <PageHeader
        title="Evaluations"
        subtitle="Each evaluation runs a sample of a dataset through several models and scores them against ground truth."
        actions={
          <>
            {all.length > 1 && (
              <Tooltip content={sel.length === 2 ? "Compare the two selected evaluations" : "Tick two evaluations to compare them"} side="bottom">
                <Button icon={<GitCompareArrows className="size-3.5" />} disabled={sel.length !== 2} onClick={() => go({ page: "compare", a: sel[0], b: sel[1] })}>
                  Compare{sel.length ? ` (${sel.length}/2)` : ""}
                </Button>
              </Tooltip>
            )}
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "new-experiment" })}>
              New evaluation
            </Button>
          </>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data?.length === 0 && (
        <Empty icon={<FlaskConical className="size-5" />} title="No evaluations yet" action={<Button variant="primary" onClick={() => go({ page: "datasets" })}>Pick a dataset</Button>}>
          Import a dataset with a label column, then compare models on it.
        </Empty>
      )}
      {all.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField value={search} onChange={setSearch} placeholder="Search name, dataset, model…" className="w-64" />
            <Select className="min-w-[9rem]" value={status} onChange={setStatus} options={[{ value: "", label: "Any status" }, ...statuses.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} />
            {datasets.length > 1 && <Select className="min-w-[10rem]" value={dataset} onChange={setDataset} options={[{ value: "", label: "Any dataset" }, ...datasets.map(([id, name]) => ({ value: id, label: name }))]} />}
            {models.length > 1 && <Select className="min-w-[9rem]" value={model} onChange={setModel} options={[{ value: "", label: "Any model" }, ...models.map((m) => ({ value: m, label: shortModel(m) }))]} />}
            {filtered && (
              <Button variant="ghost" size="sm" onClick={() => (setSearch(""), setStatus(""), setDataset(""), setModel(""))}>
                Clear
              </Button>
            )}
            <span className="ml-auto text-[12px] text-faint tnum">{filtered ? `${rows.length} of ${all.length}` : `${all.length} evaluations`}</span>
          </div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-[11.5px] text-faint">
              <tr>
                <th className="w-8 py-2.5" />
                <SortTh k="name" sort={sort} onSort={setSort}>Evaluation</SortTh>
                <SortTh k="dataset" sort={sort} onSort={setSort} className="px-3">Dataset</SortTh>
                <SortTh k="models" sort={sort} onSort={setSort} className="px-3">Models</SortTh>
                <SortTh k="rows" sort={sort} onSort={setSort} align="right" className="px-3">Rows</SortTh>
                <SortTh k="status" sort={sort} onSort={setSort} className="px-3">Status</SortTh>
                <SortTh k="created" sort={sort} onSort={setSort} align="right">Created</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
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
                    <td className="px-3 py-3">{e.status === "running" ? <Progress value={done / total} className="w-24" /> : <StatusBadge status={e.status} />}</td>
                    <td className="whitespace-nowrap py-3 text-right text-[12px] text-faint">{ago(e.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">No evaluations match these filters.</div>}
        </>
      )}
    </>
  );
}
