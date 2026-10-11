// CSV export of a Bulk run: the input (or its dataset columns), then an answer and a probability per question.
import { answerCells, answerColumns } from "./answers";
import { api, pickSavePath } from "./api";
import { describeError } from "./errors";
import type { BulkRowData, BulkRunSummary } from "./types";

export async function exportBulkCsv(run: BulkRunSummary, rows: BulkRowData[]): Promise<number | null> {
  const ids = Object.keys(run.titles);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const kind = (id: string) => rows.find((r) => r.answers?.[id])?.answers?.[id].type;
  const dataset = run.source === "dataset";
  const header = ["row", ...(dataset ? run.columns : ["input"]), ...ids.flatMap((id) => answerColumns(id, kind(id))), "error"];
  const body = rows.map((r) => [
    String(r.idx + 1),
    ...(dataset ? run.columns.map((c) => r.fields?.[c] ?? "") : [r.input]),
    ...ids.flatMap((id) => answerCells(r.answers?.[id])),
    r.error != null ? describeError(r.error).message : "",
  ]);
  const path = await pickSavePath(`${run.name.replace(/[^\w.-]+/g, "_") || "bulk"}.csv`);
  if (!path) return null;
  await api.saveTextFile(path, [header, ...body].map((line) => line.map(esc).join(",")).join("\n"));
  return rows.length;
}
