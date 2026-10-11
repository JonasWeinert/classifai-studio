// Save Bulk results as a dataset. Results of a dataset link to its rows and store only the answer
// columns; pasted entries become a new dataset with an input column.
import { Link2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { answerCells, shortColumnName } from "../lib/answers";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { describeError } from "../lib/errors";
import { shortModel } from "../lib/format";
import type { BulkRunSummary, Dataset, Row } from "../lib/types";
import type { BulkRow } from "./BulkResults";
import { Button, Checkbox, Input, Modal } from "./ui";

export function SaveResultsModal({ open, onClose, rows, run, onSaved }: { open: boolean; onClose: () => void; rows: BulkRow[]; run: BulkRunSummary; onSaved: (d: Dataset) => void }) {
  const { toast } = useApp();
  const ids = Object.keys(run.titles);
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [withConfidence, setWithConfidence] = useState(true);
  const [busy, setBusy] = useState(false);
  const answered = useMemo(() => rows.filter((r) => r.answers), [rows]);
  const kind = (id: string) => answered.find((r) => r.answers?.[id])?.answers?.[id].type;
  const linked = run.source === "dataset" && !!run.dataset_id;
  const sourceColumns = run.setup?.sourceColumns;

  useEffect(() => {
    if (!open) return;
    setName(run.name);
    const taken: string[] = [];
    setNames(
      Object.fromEntries(
        ids.map((id) => {
          let n = sourceColumns?.[id] ? `${sourceColumns[id]}_pred` : shortColumnName(run.titles[id] ?? id, id);
          for (let k = 2; taken.includes(n); k++) n = `${n}_${k}`;
          taken.push(n);
          return [id, n];
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run]);

  const col = (id: string) => names[id]?.trim() || id;
  const confCol = (id: string) => `${col(id)} ${kind(id) === "noul" ? "p(yes)" : "confidence"}`;
  const columns = ids.flatMap((id) => (withConfidence ? [col(id), confCol(id)] : [col(id)]));
  const duplicate = new Set(columns).size !== columns.length;

  const cells = (r: BulkRow): Row =>
    Object.fromEntries(
      ids.flatMap((id) => {
        const [value, conf] = answerCells(r.answers?.[id]);
        return withConfidence ? [[col(id), value], [confCol(id), conf]] : [[col(id), value]];
      }),
    );

  const submit = async () => {
    setBusy(true);
    try {
      const d = linked
        ? await api.datasetDerive(run.dataset_id!, name, answered.map((r) => [r.idx, cells(r)]), `Bulk · ${shortModel(run.model)}`)
        : await api.datasetCreate(name, ["input", ...columns], answered.map((r) => ({ input: r.input, ...cells(r) })));
      await api.bulkRunSetSaved(run.id, d.id);
      onSaved(d);
      onClose();
      toast(`Saved “${d.name}” · ${d.row_count.toLocaleString()} rows`, "good");
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={540}
      title="Save results as a dataset"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || answered.length === 0 || duplicate} loading={busy} onClick={submit}>
            Save {answered.length.toLocaleString()} rows
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input value={name} onChange={setName} placeholder="Dataset name" autoFocus />

        <div className="flex gap-2.5 rounded-[12px] bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
          {linked ? (
            <>
              <Link2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <p>
                Links to {answered.length.toLocaleString()} rows of <b className="font-medium text-foreground">{run.dataset_name}</b> instead of copying them. Only the {columns.length} answer columns below are stored; it otherwise works like any
                dataset.
              </p>
            </>
          ) : (
            <p>
              A new dataset of {answered.length.toLocaleString()} rows: the <span className="font-mono">input</span> and the {columns.length} answer columns below.
            </p>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[12px] font-medium text-muted-foreground">Columns</span>
            <Checkbox checked={withConfidence} onChange={setWithConfidence} label="With confidence" />
          </div>
          <div className="space-y-1.5">
            {ids.map((id) => (
              <div key={id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,13rem)] items-center gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px]" title={run.titles[id]}>
                    {run.titles[id]}
                  </div>
                  {withConfidence && <div className="truncate font-mono text-[10.5px] text-faint">+ {confCol(id)}</div>}
                </div>
                <Input mono value={names[id] ?? id} onChange={(v) => setNames({ ...names, [id]: v })} />
              </div>
            ))}
          </div>
          {duplicate && <div className="mt-2 text-[11.5px] text-warn">Two columns have the same name.</div>}
          {linked && <div className="mt-2 text-[11.5px] text-faint">A name already used by {run.dataset_name} gets a number added.</div>}
          {answered.length < rows.length && <div className="mt-1 text-[11.5px] text-faint">{(rows.length - answered.length).toLocaleString()} entries without answers are left out.</div>}
        </div>
      </div>
    </Modal>
  );
}
