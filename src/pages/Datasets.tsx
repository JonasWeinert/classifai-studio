import { Database, FileUp, FlaskConical, Table2 } from "lucide-react";
import { Button, Card, Empty, ErrorNote, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useImportDataset } from "../lib/useImportDataset";
import { useApp, useAsync } from "../lib/app";
import { ago } from "../lib/format";

export function Datasets() {
  const { go } = useApp();
  const { data, error, loading } = useAsync(() => api.datasets(), []);
  const exps = useAsync(() => api.experiments(), []);
  const imp = useImportDataset();

  return (
    <>
      <PageHeader
        title="Datasets"
        subtitle="Import CSV, TSV, JSON or JSONL. Pick the input and the ground-truth column when you set up an experiment."
        actions={
          <Button variant="primary" icon={<FileUp className="size-3.5" />} loading={imp.busy} onClick={imp.run}>
            Import file
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && (
        <div>
          <Empty
            icon={<Database className="size-5" />}
            title="No datasets yet"
            action={
              <Button variant="primary" icon={<FileUp className="size-3.5" />} loading={imp.busy} onClick={imp.run}>
                Import your first dataset
              </Button>
            }
          >
            Each row needs some text to classify and, for evaluation, a column with the correct label.
          </Empty>
        </div>
      )}
      {data && data.length > 0 && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {data.map((d) => {
            const n = exps.data?.filter((e) => e.dataset_id === d.id).length ?? 0;
            return (
              <Card key={d.id} className="group p-4 transition-colors duration-150 hover:bg-sel fade-up" onClick={() => go({ page: "dataset", id: d.id })}>
                <div className="flex items-start gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-background text-muted-foreground">
                    <Table2 className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{d.name}</div>
                    <div className="mt-0.5 text-[12px] text-muted-foreground tnum">
                      {d.row_count.toLocaleString()} rows · {d.columns.length} columns · {ago(d.created_at)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.columns.slice(0, 6).map((c) => (
                    <span key={c} className="rounded-full bg-background px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {c}
                    </span>
                  ))}
                  {d.columns.length > 6 && <span className="px-1 text-[10.5px] text-faint">+{d.columns.length - 6}</span>}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <FlaskConical className="size-3.5" /> {n} experiment{n === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      go({ page: "new-experiment", datasetId: d.id });
                    }}
                  >
                    New experiment →
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
