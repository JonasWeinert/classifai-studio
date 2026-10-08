import clsx from "clsx";
import { ChevronLeft, ChevronRight, FlaskConical, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Distribution } from "../components/charts";
import { Badge, Button, CardHeader, ErrorNote, Modal, PageHeader, Spinner } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { guessLabelColumn } from "../lib/columns";
import { ago, pct } from "../lib/format";
import type { ValueCount } from "../lib/types";

const PAGE = 50;

export function DatasetDetail({ id }: { id: string }) {
  const { go, toast } = useApp();
  const ds = useAsync(() => api.dataset(id), [id]);
  const [offset, setOffset] = useState(0);
  const rows = useAsync(() => api.datasetRows(id, offset, PAGE), [id, offset]);
  const exps = useAsync(() => api.experiments(id), [id]);
  const [column, setColumn] = useState<string | null>(null);
  const [counts, setCounts] = useState<ValueCount[] | null>(null);
  const [confirm, setConfirm] = useState(false);

  const d = ds.data;
  useEffect(() => {
    if (d && !column) setColumn(guessLabelColumn(d.columns));
  }, [d, column]);
  useEffect(() => {
    if (!column) return;
    setCounts(null);
    api.valueCounts(id, column).then(setCounts).catch(() => setCounts([]));
  }, [id, column]);

  if (ds.error) return <ErrorNote>{ds.error}</ErrorNote>;
  if (!d) return <Spinner />;

  const distinct = counts?.length ?? 0;
  const looksCategorical = counts && distinct >= 2 && distinct <= 255 && distinct < d.row_count * 0.5;

  return (
    <>
      <PageHeader
        back={{ label: "Datasets", onClick: () => go({ page: "datasets" }) }}
        title={d.name}
        subtitle={
          <span className="tnum">
            {d.row_count.toLocaleString()} rows · {d.columns.length} columns · imported {ago(d.created_at)}
            {d.source && <span className="ml-2 font-mono text-[11.5px] text-faint">{d.source}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)}>
              Delete
            </Button>
            <Button variant="primary" icon={<FlaskConical className="size-3.5" />} onClick={() => go({ page: "new-experiment", datasetId: id })}>
              New experiment
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-10">
        <div className="min-w-0">
          <CardHeader
            className="px-0 pt-0"
            title="Rows"
            subtitle={`Showing ${offset + 1}–${Math.min(offset + PAGE, d.row_count)} of ${d.row_count.toLocaleString()}`}
            actions={
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE >= d.row_count} onClick={() => setOffset(offset + PAGE)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            }
          />
          <div className="max-h-[600px] overflow-auto border-y border-border" data-selectable>
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-background">
                <tr>
                  <th className="border-b border-border px-3 py-2 text-left font-mono text-[10.5px] font-medium text-faint">#</th>
                  {d.columns.map((c) => (
                    <th
                      key={c}
                      onClick={() => setColumn(c)}
                      className={clsx("cursor-pointer whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium hover:text-foreground", c === column ? "text-primary" : "text-muted-foreground")}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.data?.rows.map(([i, r]) => (
                  <tr key={i} className="hover:bg-sel/60">
                    <td className="border-b border-border px-3 py-1.5 font-mono text-[10.5px] text-faint tnum">{i + 1}</td>
                    {d.columns.map((c) => (
                      <td key={c} className={clsx("max-w-[340px] truncate border-b border-border px-3 py-1.5", c === column && "bg-primary/10/40")} title={r[c]}>
                        {r[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="border-b border-border pb-5">
            <CardHeader className="px-0 pt-0" title={<span>Column <span className="font-mono text-primary">{column}</span></span>} subtitle="Click a header to profile another column." />
            <div>
              {!counts ? (
                <Spinner />
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <Badge>{distinct >= 300 ? "300+" : distinct} distinct</Badge>
                    {looksCategorical ? <Badge tone="good">Looks like labels</Badge> : <Badge>Free text</Badge>}
                  </div>
                  <Distribution items={counts.slice(0, 12)} total={d.row_count} />
                  {counts.length > 12 && <div className="mt-2 text-[11.5px] text-faint">+{counts.length - 12} more values ({pct(counts.slice(12).reduce((a, c) => a + c.count, 0) / d.row_count)} of rows)</div>}
                  {looksCategorical && (
                    <Button className="mt-4 w-full" variant="secondary" size="sm" onClick={() => go({ page: "new-experiment", datasetId: id })}>
                      Use as ground truth →
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          <div>
            <CardHeader className="px-0" title="Experiments" subtitle={exps.data?.length ? undefined : "None yet"} />
            <div className="-mx-2">
              {exps.data?.map((e) => (
                <button key={e.id} onClick={() => go({ page: "experiment", id: e.id })} className="flex w-full items-center justify-between rounded-[6px] px-2 py-2 text-left hover:bg-sel">
                  <span className="truncate text-[12.5px] font-medium">{e.name}</span>
                  <span className="text-[11.5px] text-faint">{ago(e.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete dataset?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                try {
                  await api.datasetDelete(id);
                  toast(`Deleted ${d.name}`);
                  go({ page: "datasets" });
                } catch (e) {
                  toast(errorMessage(e), "bad");
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          This removes <b className="text-foreground">{d.name}</b> and its {exps.data?.length ?? 0} experiment(s) from ClassifAI. The original file is not touched.
        </p>
      </Modal>
    </>
  );
}
