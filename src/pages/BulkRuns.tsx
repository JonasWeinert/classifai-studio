// Bulk runs: every run is kept with its answers. The list shows them all; a run's page shows its
// results, and either can save a run's answers as a dataset.
import { Check, Copy, Database, DatabaseZap, Download, Pencil, Plus, Rows3, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BulkResults } from "../components/BulkResults";
import { ModelLoading } from "../components/RunPieces";
import { useModelState } from "../lib/modelStatus";
import { SaveResultsModal } from "../components/SaveResultsModal";
import { Badge, Button, Card, compareValues, Empty, ErrorNote, Input, Modal, PageHeader, Progress, SearchField, Select, SortTh, Spinner, Tooltip, type SortState } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { exportBulkCsv } from "../lib/bulkExport";
import { stopBulk, useActiveBulk } from "../lib/bulkRunner";
import { describeError } from "../lib/errors";
import { ago, modelColor, shortModel, usd } from "../lib/format";
import type { BulkRun, BulkRunSummary } from "../lib/types";

type Key = "name" | "entries" | "model" | "questions" | "answered" | "status" | "created";

const STATUS: Record<BulkRunSummary["status"], [string, "accent" | "good" | "warn"]> = {
  running: ["Running", "accent"],
  completed: ["Completed", "good"],
  cancelled: ["Stopped", "warn"],
};

function StatusBadge({ status }: { status: BulkRunSummary["status"] }) {
  const [label, tone] = STATUS[status];
  return (
    <Badge tone={tone}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      {label}
    </Badge>
  );
}

const sortValue = (r: BulkRunSummary, k: Key): string | number => {
  switch (k) {
    case "name":
      return r.name;
    case "entries":
      return r.dataset_name ?? "";
    case "model":
      return shortModel(r.model);
    case "questions":
      return Object.keys(r.titles).length;
    case "answered":
      return r.answered;
    case "status":
      return STATUS[r.status][0];
    case "created":
      return r.created_at;
  }
};

/** Save a run (fetching its rows first) as a dataset; used from the list and the run page. */
function useSaveRun(onSaved: () => void) {
  const { toast } = useApp();
  const [run, setRun] = useState<BulkRun | null>(null);
  const open = (id: string) => api.bulkRun(id).then(setRun).catch((e) => toast(describeError(e).message, "bad"));
  const modal = run && <SaveResultsModal open onClose={() => setRun(null)} rows={run.rows} run={run} onSaved={onSaved} />;
  return { open, modal };
}

export function BulkRuns() {
  const { go, toast } = useApp();
  const runs = useAsync(() => api.bulkRuns(), []);
  const active = useActiveBulk();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<SortState<Key>>({ key: "created", desc: true });
  const [deleting, setDeleting] = useState<BulkRunSummary | null>(null);
  const save = useSaveRun(() => runs.reload());

  // Keep the running run's progress fresh, and pick up its end.
  const activeDone = active?.rows.filter((r) => r.answers || r.error != null).length ?? 0;
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => runs.reload(), active.running ? 1000 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.running, Math.floor(activeDone / 10)]);

  const all = runs.data ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = all.filter((r) => (!status || r.status === status) && (!q || [r.name, r.dataset_name ?? "pasted", r.model, ...Object.values(r.titles)].some((s) => s.toLowerCase().includes(q))));
    if (sort) out.sort((a, b) => compareValues(sortValue(a, sort.key), sortValue(b, sort.key)) * (sort.desc ? -1 : 1));
    return out;
  }, [all, search, status, sort]);

  return (
    <>
      <PageHeader
        title="Bulk"
        subtitle="Ask your questions about many entries with one model. Every run is kept; save any run as a dataset."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "bulk-new" })}>
            New bulk run
          </Button>
        }
      />
      {runs.error && <ErrorNote>{runs.error}</ErrorNote>}
      {runs.loading && !runs.data && <Spinner />}
      {runs.data?.length === 0 && (
        <Empty icon={<Rows3 />} title="No bulk runs yet" action={<Button variant="primary" onClick={() => go({ page: "bulk-new" })}>New bulk run</Button>}>
          Paste entries or pick a dataset, ask your questions, and get answers for every row.
        </Empty>
      )}
      {all.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField value={search} onChange={setSearch} placeholder="Search name, dataset, question…" className="w-64" />
            <Select
              className="min-w-[9rem]"
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "Any status" },
                { value: "completed", label: "Completed" },
                { value: "cancelled", label: "Stopped" },
                { value: "running", label: "Running" },
              ]}
            />
            <span className="ml-auto text-[12px] text-faint tnum">{search || status ? `${rows.length} of ${all.length}` : `${all.length} runs`}</span>
          </div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-[11.5px] text-faint">
              <tr>
                <SortTh k="name" sort={sort} onSort={setSort}>Run</SortTh>
                <SortTh k="entries" sort={sort} onSort={setSort} className="px-3">Entries</SortTh>
                <SortTh k="model" sort={sort} onSort={setSort} className="px-3">Model</SortTh>
                <SortTh k="questions" sort={sort} onSort={setSort} align="right" className="px-3">Questions</SortTh>
                <SortTh k="answered" sort={sort} onSort={setSort} align="right" className="px-3">Answered</SortTh>
                <SortTh k="status" sort={sort} onSort={setSort} className="px-3">Status</SortTh>
                <th className="px-3 py-2.5 text-left font-medium">Dataset</th>
                <SortTh k="created" sort={sort} onSort={setSort} align="right">Created</SortTh>
                <th className="w-[1%]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const live = active?.id === r.id && active.running;
                const done = live ? activeDone : r.answered + r.failed;
                return (
                  <tr key={r.id} onClick={() => go({ page: "bulk-run", id: r.id })} className="group cursor-pointer border-t border-border hover:bg-sel/50">
                    <td className="py-2.5 font-medium">
                      <span className="block max-w-[16rem] truncate">{r.name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <span className="block max-w-[14rem] truncate">{r.source === "dataset" ? r.dataset_name : "Pasted"}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
                        <span className="size-1.5 rounded-full" style={{ background: modelColor(0) }} />
                        {shortModel(r.model)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground tnum">{Object.keys(r.titles).length}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] text-muted-foreground tnum">
                      {live ? done : r.answered}/{r.total}
                      {r.failed > 0 && !live && <span className="ml-1 text-bad">·{r.failed}✕</span>}
                    </td>
                    <td className="px-3 py-2.5">{live ? <Progress value={done / Math.max(1, r.total)} className="w-20" /> : <StatusBadge status={r.status} />}</td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      {r.saved_dataset_id && r.saved_dataset_name ? (
                        <button onClick={() => go({ page: "dataset", id: r.saved_dataset_id! })} className="inline-flex max-w-[12rem] items-center gap-1 text-[12px] text-good hover:underline">
                          <Check className="size-3 shrink-0" /> <span className="truncate">{r.saved_dataset_name}</span>
                        </button>
                      ) : (
                        <Button size="sm" variant="ghost" icon={<DatabaseZap className="size-3" />} disabled={live || r.answered === 0} onClick={() => save.open(r.id)}>
                          Save…
                        </Button>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right text-[12px] text-faint">{ago(r.created_at)}</td>
                    <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Tooltip content="Duplicate and edit">
                          <Button size="icon" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => go({ page: "bulk-new", from: r.id })} />
                        </Tooltip>
                        <Tooltip content="Delete">
                          <Button size="icon" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={live} onClick={() => setDeleting(r)} />
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">No runs match these filters.</div>}
        </>
      )}
      {save.modal}
      <DeleteRun
        run={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          toast(`Deleted ${deleting!.name}`);
          runs.reload();
        }}
      />
    </>
  );
}

function DeleteRun({ run, onClose, onDeleted }: { run: BulkRunSummary | null; onClose: () => void; onDeleted: () => void }) {
  const { toast } = useApp();
  return (
    <Modal
      open={!!run}
      onClose={onClose}
      title="Delete bulk run?"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            className="!bg-bad"
            onClick={async () => {
              try {
                await api.bulkRunDelete(run!.id);
                onDeleted();
              } catch (e) {
                toast(errorMessage(e), "bad");
              }
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">
        The answers of “{run?.name}” are removed.{run?.saved_dataset_name ? ` The dataset “${run.saved_dataset_name}” saved from it stays.` : ""}
      </p>
    </Modal>
  );
}

export function BulkRunDetail({ id }: { id: string }) {
  const { go, toast } = useApp();
  const [run, setRun] = useState<BulkRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = useActiveBulk(id);
  const running = !!active?.running;

  const reload = () => api.bulkRun(id).then(setRun).catch(setError);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, running]);

  if (error) return <ErrorNote error={error} />;
  if (!run) return <Spinner />;
  const rows = active?.rows ?? run.rows;
  const answered = rows.filter((r) => r.answers).length;
  const n = Object.keys(run.titles).length;

  const rename = async () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (!name || name === run.name) return;
    await api.bulkRunRename(id, name);
    setRun({ ...run, name });
  };

  return (
    <>
      <PageHeader
        back={{ label: "Bulk runs", onClick: () => go({ page: "bulk" }) }}
        title={
          renaming !== null ? (
            <form className="-my-1 max-w-sm font-normal" onSubmit={(e) => (e.preventDefault(), rename())} onBlur={rename} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}>
              <Input autoFocus value={renaming} onChange={setRenaming} />
            </form>
          ) : (
            <span className="flex items-center gap-3">
              <button onClick={() => setRenaming(run.name)} className="group/title inline-flex min-w-0 items-center gap-1.5 text-left">
                <span className="truncate">{run.name}</span>
                <Pencil className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover/title:opacity-100" />
              </button>
              {running ? <StatusBadge status="running" /> : <StatusBadge status={run.status} />}
            </span>
          )
        }
        subtitle={`${ago(run.created_at)}${run.cost_usd > 0 ? ` · ${usd(run.cost_usd)}` : ""}`}
        actions={
          <>
            {running ? (
              <Button icon={<Square className="size-3" />} onClick={stopBulk}>
                Stop
              </Button>
            ) : (
              <>
                <Tooltip content="Delete run" side="bottom">
                  <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(true)} />
                </Tooltip>
                <Button variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => go({ page: "bulk-new", from: id })}>
                  Duplicate…
                </Button>
                <Button
                  icon={<Download className="size-3.5" />}
                  onClick={async () => {
                    const n = await exportBulkCsv(run, rows);
                    if (n !== null) toast(`Exported ${n} rows`, "good");
                  }}
                >
                  Export CSV
                </Button>
                {run.saved_dataset_id && run.saved_dataset_name ? (
                  <Button icon={<Check className="size-3.5" />} onClick={() => go({ page: "dataset", id: run.saved_dataset_id! })}>
                    Open saved dataset
                  </Button>
                ) : (
                  <Button variant="primary" icon={<DatabaseZap className="size-3.5" />} disabled={answered === 0} onClick={() => setSaving(true)}>
                    Save as dataset
                  </Button>
                )}
              </>
            )}
          </>
        }
      />

      <Card className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-[12.5px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <Database className="size-3.5 shrink-0 text-faint" />
          {run.source === "dataset" ? (
            <>
              {run.dataset_id ? (
                <button onClick={() => go({ page: "dataset", id: run.dataset_id! })} className="truncate font-medium hover:underline">
                  {run.dataset_name}
                </button>
              ) : (
                <b className="truncate font-medium">{run.dataset_name}</b>
              )}
              <span className="truncate font-mono text-[11.5px] text-muted-foreground">{run.columns.join(", ")}</span>
            </>
          ) : (
            <b className="font-medium">Pasted entries</b>
          )}
          <span className="text-muted-foreground tnum">· {run.total.toLocaleString()}</span>
        </span>
        <span className="text-muted-foreground">
          <b className="font-medium text-foreground tnum">{n}</b> question{n === 1 ? "" : "s"}
          {run.setup?.set && <span> from “{run.setup.set.name}”</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: modelColor(0) }} />
          <b className="font-medium">{shortModel(run.model)}</b>
        </span>
        {run.saved_dataset_name && <span className="ml-auto text-good">Saved as {run.saved_dataset_name}</span>}
      </Card>

      {running && <BulkWarmup model={run.model} />}
      <BulkResults rows={rows} titles={run.titles} running={running} />

      <SaveResultsModal open={saving} onClose={() => setSaving(false)} rows={rows} run={run} onSaved={() => reload()} />
      <DeleteRun run={deleting ? run : null} onClose={() => setDeleting(false)} onDeleted={() => go({ page: "bulk" })} />
    </>
  );
}

function BulkWarmup({ model }: { model: string }) {
  const { state, since } = useModelState(model);
  if (state !== "loading") return null;
  return (
    <div className="mb-4 fade-up">
      <ModelLoading model={model} since={since} />
    </div>
  );
}
