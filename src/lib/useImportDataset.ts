import { useState } from "react";
import { api, errorMessage, pickFile } from "./api";
import { useApp } from "./app";

/** Pick a file, import it, and open the new dataset. */
export function useImportDataset() {
  const { go, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const path = await pickFile();
    if (!path) return;
    setBusy(true);
    try {
      const d = await api.datasetImport(path);
      toast(`Imported ${d.name} · ${d.row_count.toLocaleString()} rows`, "good");
      go({ page: "dataset", id: d.id });
    } catch (e) {
      toast(`Import failed: ${errorMessage(e)}`, "bad");
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}
