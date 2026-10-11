import { useCallback, useState } from "react";
import { api, DOCUMENT_EXTENSIONS, extOf, IMAGE_EXTENSIONS, SPREADSHEET_EXTENSIONS, WORKBOOK_EXTENSIONS } from "./api";
import { useApp } from "./app";
import { describeError } from "./errors";
import type { Dataset } from "./types";

/** Import a dataset from the file picker, a dropped path, or pasted/dropped text; then open it. */
export function useImportDataset() {
  const { go, toast } = useApp();
  const [busy, setBusy] = useState(false);

  const finish = useCallback(
    async (job: Promise<Dataset>) => {
      setBusy(true);
      try {
        const d = await job;
        toast(`Imported ${d.name} · ${d.row_count.toLocaleString()} rows`, "good");
        go({ page: "dataset", id: d.id });
      } catch (e) {
        toast(`Import failed: ${describeError(e).message}`, "bad");
      } finally {
        setBusy(false);
      }
    },
    [go, toast],
  );

  /** The import chooser (spreadsheet, Hugging Face, documents and images). */
  const run = useCallback(() => go({ page: "datasets", import: true }), [go]);
  const importPath = useCallback((path: string) => finish(api.datasetImport(path)), [finish]);
  /** Dropped files: documents and images to the files dialog, a workbook to its sheet dialog, a CSV/JSON straight in. */
  const importPaths = useCallback(
    (paths: string[]) => {
      const files = paths.filter((p) => [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS].includes(extOf(p)));
      const workbook = paths.find((p) => WORKBOOK_EXTENSIONS.includes(extOf(p)));
      const table = paths.find((p) => SPREADSHEET_EXTENSIONS.includes(extOf(p)) && !WORKBOOK_EXTENSIONS.includes(extOf(p)));
      if (files.length) go({ page: "datasets", files });
      else if (workbook) go({ page: "datasets", workbook });
      else if (table) finish(api.datasetImport(table));
      else toast("Drop a spreadsheet, document or image", "bad");
    },
    [finish, go, toast],
  );
  const importText = useCallback((name: string, text: string) => finish(api.datasetImportText(name, text)), [finish]);

  return { run, importPath, importPaths, importText, busy };
}
