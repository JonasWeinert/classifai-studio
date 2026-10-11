// Runs Bulk requests in the background: answers stream into the open run page (if any) and are
// stored in the database in small batches, so a run survives navigating away. One run at a time.
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { classifyRouted, type RoutedItem } from "./routing";
import type { BulkRowData, BulkRunInput } from "./types";

interface Active {
  id: string;
  rows: BulkRowData[];
  running: boolean;
}

let active: Active | null = null;
let stopRequested = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function patch(pos: number, p: Partial<BulkRowData>) {
  if (!active) return;
  active = { ...active, rows: active.rows.map((r) => (r.pos === pos ? { ...r, ...p } : r)) };
  notify();
}

/** The run being executed, if it is `id` (or any run without an id). */
export function useActiveBulk(id?: string): Active | null {
  const a = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active,
  );
  return a && (!id || a.id === id) ? a : null;
}

export const isBulkRunning = () => !!active?.running;

export function stopBulk() {
  stopRequested = true;
}

const plainError = (e: unknown) => (e && typeof e === "object" ? e : { code: "ERROR", message: String(e) });

/**
 * Create a run and start answering its entries. Resolves with the run id once it exists; the
 * requests continue in the background and `onDone` is called when they finish or are stopped.
 */
export async function startBulk(
  input: BulkRunInput,
  inputs: string[],
  fields: (Record<string, string> | null)[],
  /** Questions with their follow-up routes; follow-ups run as further passes per entry. */
  items: RoutedItem[],
  onDone?: (stopped: boolean) => void,
): Promise<string> {
  if (active?.running) throw { code: "BUSY", message: "A Bulk run is already in progress. Stop it first." };
  const run = await api.bulkRunCreate(input);
  stopRequested = false;
  active = { id: run.id, running: true, rows: input.entries.map((e, pos) => ({ pos, idx: e.row_idx, input: inputs[pos], fields: fields[pos] })) };
  notify();

  let buffer: Parameters<typeof api.bulkResultsPut>[1] = [];
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    await api.bulkResultsPut(run.id, batch).catch(() => {
      buffer.unshift(...batch);
    });
  };
  const timer = setInterval(flush, 500);

  let next = 0;
  const model = input.model;
  const worker = async () => {
    while (!stopRequested && next < inputs.length) {
      const pos = next++;
      try {
        const r = await classifyRouted(model, inputs[pos], items);
        const cost = r.cost_usd ?? 0;
        patch(pos, { answers: r.answers, latency: r.latency_ms, cost });
        buffer.push({ pos, answers: r.answers, latency_ms: r.latency_ms, cost_usd: cost });
      } catch (e) {
        patch(pos, { error: plainError(e) });
        buffer.push({ pos, error: plainError(e) });
      }
    }
  };

  // Cloud models handle parallel requests well; a local model answers fastest with a few in flight.
  void Promise.all(Array.from({ length: model.startsWith("@") ? 6 : 3 }, worker)).then(async () => {
    clearInterval(timer);
    await flush();
    const stopped = stopRequested;
    await api.bulkRunFinish(run.id, stopped ? "cancelled" : "completed").catch(() => {});
    if (active?.id === run.id) active = { ...active, running: false };
    notify();
    onDone?.(stopped);
  });
  return run.id;
}
