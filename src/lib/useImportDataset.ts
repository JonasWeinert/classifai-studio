import { useCallback, useState } from "react";
import { api, pickFile } from "./api";
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

  const run = useCallback(async () => {
    const path = await pickFile();
    if (path) await finish(api.datasetImport(path));
  }, [finish]);
  const importPath = useCallback((path: string) => finish(api.datasetImport(path)), [finish]);
  const importText = useCallback((name: string, text: string) => finish(api.datasetImportText(name, text)), [finish]);

  return { run, importPath, importText, busy };
}
