import { FlaskConical, Plus } from "lucide-react";
import { Button, Card, Empty, ErrorNote, PageHeader, Progress, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago, modelColor, shortModel } from "../lib/format";
import { StatusBadge } from "./ExperimentDetail";

export function Experiments() {
  const { go } = useApp();
  const { data, error, loading } = useAsync(() => api.experiments(), []);

  return (
    <>
      <PageHeader
        title="Experiments"
        subtitle="Each experiment runs a sample of a dataset through several models and scores them against ground truth."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "new-experiment" })}>
            New experiment
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data?.length === 0 && (
        <Card>
          <Empty icon={<FlaskConical className="size-5" />} title="No experiments yet" action={<Button variant="primary" onClick={() => go({ page: "datasets" })}>Pick a dataset</Button>}>
            Import a dataset with a label column, then compare models on it.
          </Empty>
        </Card>
      )}
      {data && data.length > 0 && (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-panel-2/60 text-[11.5px] text-faint">
              <tr>
                <th className="px-5 py-2.5 text-left font-medium">Experiment</th>
                <th className="px-3 py-2.5 text-left font-medium">Dataset</th>
                <th className="px-3 py-2.5 text-left font-medium">Models</th>
                <th className="px-3 py-2.5 text-right font-medium">Rows</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => {
                const total = e.row_indices.length * e.config.models.length;
                const done = Object.values(e.progress).reduce((a, b) => a + b, 0);
                return (
                  <tr key={e.id} onClick={() => go({ page: "experiment", id: e.id })} className="cursor-pointer border-t border-line hover:bg-panel-2/50">
                    <td className="px-5 py-3 font-medium">{e.name}</td>
                    <td className="px-3 py-3 text-muted">{e.dataset_name}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {e.config.models.map((m, i) => (
                          <span key={m} className="flex items-center gap-1 text-[12px] text-muted">
                            <span className="size-1.5 rounded-full" style={{ background: modelColor(i) }} />
                            {shortModel(m)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-[12px] text-muted tnum">{e.row_indices.length.toLocaleString()}</td>
                    <td className="px-3 py-3">
                      {e.status === "running" ? <Progress value={done / total} className="w-24" /> : <StatusBadge status={e.status} />}
                    </td>
                    <td className="px-5 py-3 text-right text-[12px] text-faint">{ago(e.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
