// Choose a dataset entry without leaving the page: search the rows, see each one's input as it
// would be sent, pick one.
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Row } from "../lib/types";
import { composeInput } from "./OpenRowModal";
import { Button, Modal, SearchField, Spinner } from "./ui";

const PAGE = 50;

export function EntryPicker({ open, datasetId, datasetName, inputCols, current, onPick, onClose }: { open: boolean; datasetId: string; datasetName: string; inputCols: string[]; current: number; onPick: (row: [number, Row]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<[number, Row][]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Debounced search; a new query starts from the top.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .datasetRows(datasetId, 0, PAGE, { search: query.trim() || undefined })
        .then((p) => {
          if (!live) return;
          setRows(p.rows);
          setTotal(p.total);
        })
        .finally(() => live && setLoading(false));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, datasetId, query]);

  const more = async () => {
    setLoading(true);
    try {
      const p = await api.datasetRows(datasetId, rows.length, PAGE, { search: query.trim() || undefined });
      setRows((r) => [...r, ...p.rows]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={620} title={`Choose an entry of ${datasetName}`}>
      <SearchField className="w-full" value={query} onChange={setQuery} placeholder={`Search ${total.toLocaleString()} entries`} />
      <div className="mt-2 max-h-[420px] min-h-[160px] overflow-y-auto rounded-[10px] border border-border">
        {rows.length === 0 ? (
          <div className="grid min-h-[158px] place-items-center text-[12.5px] text-muted-foreground">{loading ? <Spinner /> : `No entry matches “${query}”.`}</div>
        ) : (
          <>
            {rows.map(([i, row]) => (
              <button
                key={i}
                onClick={() => onPick([i, row])}
                className={cn("flex w-full gap-3 border-b border-border/60 px-3 py-2 text-left last:border-0", i === current ? "bg-primary/10" : "hover:bg-sel")}
              >
                <span className="w-12 shrink-0 pt-px font-mono text-[11px] text-faint tnum">#{i + 1}</span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug whitespace-pre-line">{composeInput(row, inputCols) || <span className="text-faint">empty</span>}</span>
              </button>
            ))}
            {rows.length < total && (
              <div className="p-2 text-center">
                <Button size="sm" variant="ghost" loading={loading} onClick={more}>
                  Show more ({(total - rows.length).toLocaleString()} left)
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
