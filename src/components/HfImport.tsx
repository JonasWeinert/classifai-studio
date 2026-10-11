// Import a dataset from the Hugging Face Hub: look it up by name or URL, pick splits, and per
// split take everything or a subset (first rows, seeded random sample, row range, SQL filter,
// full-text search).
import { cn } from "@/lib/utils";
import { ExternalLink, KeyRound, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, events, openExternal } from "../lib/api";
import { useApp } from "../lib/app";
import { describeError } from "../lib/errors";
import type { Dataset, HfInfo, HfProgress, HfSelection } from "../lib/types";
import { Button, Checkbox, Disclosure, Input, Modal, Progress, Segmented, Select } from "./ui";

type Mode = HfSelection["kind"];

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "full", label: "All rows", hint: "Every row of the split" },
  { value: "random", label: "Random sample", hint: "Rows drawn at random; the same seed gives the same rows" },
  { value: "first", label: "First rows", hint: "The first N rows, in order" },
  { value: "range", label: "Row range", hint: "N rows starting at a row number" },
  { value: "filter", label: "Filter", hint: "Rows matching an SQL condition, e.g. \"label\" = 1 AND LENGTH(\"text\") < 500" },
  { value: "search", label: "Search", hint: "Rows whose text contains the search terms" },
];

const MAX_ROWS = 200_000;

interface PartState {
  on: boolean;
  mode: Mode;
  n: string;
  seed: string;
  offset: string;
  where: string;
  query: string;
}

const EXAMPLES = ["stanfordnlp/imdb", "SetFit/emotion", "nyu-mll/glue"];

function defaultPart(split: string, rows: number | null, first: boolean): PartState {
  const usual = ["train", "validation", "test", "dev"].includes(split.toLowerCase());
  const big = rows === null || rows > 5000;
  return { on: usual || first, mode: big ? "random" : "full", n: "1000", seed: "42", offset: "0", where: "", query: "" };
}

function selection(p: PartState): HfSelection {
  const n = Math.max(1, Math.floor(Number(p.n) || 0));
  switch (p.mode) {
    case "full":
      return { kind: "full" };
    case "first":
      return { kind: "first", n };
    case "random":
      return { kind: "random", n, seed: Math.floor(Number(p.seed) || 0) };
    case "range":
      return { kind: "range", offset: Math.max(0, Math.floor(Number(p.offset) || 0)), n };
    case "filter":
      return { kind: "filter", where: p.where.trim(), n };
    case "search":
      return { kind: "search", query: p.query.trim(), n };
  }
}

/** Rows a part will import at most. */
function planned(p: PartState, rows: number | null) {
  const n = Math.max(0, Math.floor(Number(p.n) || 0));
  const cap = (k: number) => (rows === null ? k : Math.min(k, rows));
  if (p.mode === "full") return rows ?? 0;
  if (p.mode === "range") return rows === null ? n : Math.max(0, Math.min(n, rows - (Number(p.offset) || 0)));
  return cap(n);
}

export function HfImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (d: Dataset[]) => void }) {
  const { toast, go } = useApp();
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<HfInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState("");
  const [parts, setParts] = useState<Record<string, PartState>>({});
  const [columns, setColumns] = useState<string[]>([]);
  const [combine, setCombine] = useState<"one" | "each">("one");
  const [name, setName] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<HfProgress | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");

  useEffect(() => {
    if (!open) return;
    api.hfTokenStatus().then(setToken).catch(() => setToken(null));
  }, [open]);
  useEffect(() => {
    const un = events.hfProgress(setProgress);
    return () => void un.then((f) => f());
  }, []);

  const cfg = info?.configs.find((c) => c.config === config);
  useEffect(() => {
    if (!cfg) return;
    setParts(Object.fromEntries(cfg.splits.map((s, i) => [s.split, defaultPart(s.split, s.num_rows, i === 0)])));
    setColumns(cfg.features.map((f) => f.name));
  }, [cfg]);

  const lookup = async (q = query) => {
    if (!q.trim()) return;
    setQuery(q);
    setLooking(true);
    setError(null);
    setInfo(null);
    try {
      const i = await api.hfInfo(q.trim());
      setInfo(i);
      setConfig(i.configs[0].config);
      setName(i.dataset.split("/").pop() ?? i.dataset);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setLooking(false);
    }
  };

  const chosen = cfg ? cfg.splits.filter((s) => parts[s.split]?.on) : [];
  const total = chosen.reduce((a, s) => a + planned(parts[s.split], s.num_rows), 0);
  const invalid = chosen.find((s) => {
    const p = parts[s.split];
    if (p.mode === "filter" && !p.where.trim()) return true;
    if (p.mode === "search" && !p.query.trim()) return true;
    if (p.mode === "full" && s.num_rows === null) return true;
    return p.mode !== "full" && !(Number(p.n) > 0);
  });
  const tooMany = total > MAX_ROWS;
  const canImport = !!cfg && chosen.length > 0 && !invalid && !tooMany && columns.length > 0 && !importing;

  const run = async () => {
    if (!cfg || !info) return;
    setImporting(true);
    setProgress(null);
    try {
      const ds = await api.hfImport({
        dataset: info.dataset,
        parts: chosen.map((s) => ({ config: cfg.config, split: s.split, selection: selection(parts[s.split]) })),
        combine: combine === "one",
        name: name.trim() || null,
        columns: columns.length === cfg.features.length ? [] : columns,
      });
      toast(`Imported ${ds.map((d) => `${d.name} (${d.row_count.toLocaleString()} rows)`).join(", ")}`, "good");
      onImported(ds);
      onClose();
      if (ds.length === 1) go({ page: "dataset", id: ds[0].id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setImporting(false);
    }
  };

  const set = (split: string, patch: Partial<PartState>) => setParts((p) => ({ ...p, [split]: { ...p[split], ...patch } }));

  return (
    <Modal
      open={open}
      onClose={() => !importing && onClose()}
      width={680}
      title="Import from Hugging Face"
      footer={
        <>
          <span className={cn("mr-auto self-center text-[12px] tnum", tooMany ? "text-warn" : "text-muted-foreground")}>
            {cfg && (tooMany ? `${total.toLocaleString()} rows — up to ${MAX_ROWS.toLocaleString()} at once; take a subset` : `${total.toLocaleString()} rows from ${chosen.length} split${chosen.length === 1 ? "" : "s"}`)}
          </span>
          {importing ? (
            <Button onClick={() => api.hfCancel()}>Cancel</Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
          <Button variant="primary" disabled={!canImport} loading={importing} onClick={run}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            lookup();
          }}
        >
          <div className="flex-1">
            <Input value={query} onChange={setQuery} placeholder="Dataset name or URL, e.g. stanfordnlp/imdb" autoFocus />
          </div>
          <Button type="submit" icon={<Search className="size-3.5" />} loading={looking} disabled={!query.trim()}>
            Look up
          </Button>
        </form>

        {!info && !looking && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            Try
            {EXAMPLES.map((x) => (
              <button key={x} onClick={() => lookup(x)} className="rounded-full bg-sel px-2.5 py-0.5 font-mono text-[11.5px] hover:text-foreground">
                {x}
              </button>
            ))}
          </div>
        )}
        {error && <div className="rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}

        <Disclosure label={token ? `Hugging Face token saved (${token})` : "Private or gated dataset? Add a token"} defaultOpen={false}>
          <div className="flex items-center gap-2">
            <KeyRound className="size-3.5 shrink-0 text-faint" />
            <div className="flex-1">
              <Input value={tokenInput} onChange={setTokenInput} placeholder={token ? "Replace token" : "hf_…"} mono />
            </div>
            <Button
              size="sm"
              disabled={!tokenInput.trim()}
              onClick={async () => {
                await api.hfTokenSet(tokenInput);
                setTokenInput("");
                setToken(await api.hfTokenStatus());
                toast("Token saved to your keychain", "good");
              }}
            >
              Save
            </Button>
            {token && (
              <Button size="sm" variant="ghost" onClick={async () => (await api.hfTokenSet(""), setToken(null))}>
                Remove
              </Button>
            )}
          </div>
          <div className="mt-1 pl-5.5 text-[11.5px] text-faint">Stored in your macOS Keychain. Create a read token in your Hugging Face settings.</div>
        </Disclosure>

        {info && cfg && (
          <div className="space-y-4 fade-up">
            <div className="flex items-center gap-2">
              <button onClick={() => openExternal(`https://huggingface.co/datasets/${info.dataset}`)} className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold hover:underline">
                {info.dataset} <ExternalLink className="size-3 text-faint" />
              </button>
              {info.configs.length > 1 && <Select className="ml-auto min-w-[10rem]" value={config} onChange={setConfig} options={info.configs.map((c) => ({ value: c.config, label: c.config }))} />}
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">Splits</div>
              <div className="divide-y divide-border rounded-[12px] bg-card">
                {cfg.splits.map((s) => {
                  const p = parts[s.split];
                  if (!p) return null;
                  const modes = MODES.filter((m) => (m.value !== "filter" || info.can_filter) && (m.value !== "search" || info.can_search) && (m.value !== "full" || s.num_rows !== null));
                  return (
                    <div key={s.split} className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <Checkbox checked={p.on} onChange={(on) => set(s.split, { on })} />
                        <span className={cn("w-28 truncate font-mono text-[12.5px]", !p.on && "text-muted-foreground")}>{s.split}</span>
                        <span className="w-24 text-right text-[12px] text-faint tnum">{s.num_rows === null ? "? rows" : `${s.num_rows.toLocaleString()} rows`}</span>
                        {p.on && (
                          <>
                            <Select className="ml-auto min-w-[9.5rem]" value={p.mode} onChange={(m) => set(s.split, { mode: m as Mode })} options={modes.map((m) => ({ value: m.value, label: m.label }))} />
                            {p.mode !== "full" && (
                              <div className="w-[5.5rem]">
                                <Input value={p.n} onChange={(n) => set(s.split, { n })} placeholder="rows" />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {p.on && p.mode !== "full" && p.mode !== "first" && (
                        <div className="mt-2 flex items-center gap-2 pl-8 text-[12px] text-muted-foreground">
                          {p.mode === "random" && (
                            <>
                              seed
                              <div className="w-20">
                                <Input value={p.seed} onChange={(seed) => set(s.split, { seed })} mono />
                              </div>
                            </>
                          )}
                          {p.mode === "range" && (
                            <>
                              starting at row
                              <div className="w-24">
                                <Input value={p.offset} onChange={(offset) => set(s.split, { offset })} mono />
                              </div>
                            </>
                          )}
                          {p.mode === "filter" && (
                            <div className="flex-1">
                              <Input value={p.where} onChange={(where) => set(s.split, { where })} placeholder={`"${cfg.features.find((f) => f.labels)?.name ?? "label"}" = 1`} mono />
                            </div>
                          )}
                          {p.mode === "search" && (
                            <div className="flex-1">
                              <Input value={p.query} onChange={(q) => set(s.split, { query: q })} placeholder="Search terms" />
                            </div>
                          )}
                        </div>
                      )}
                      {p.on && <div className="mt-1 pl-8 text-[11.5px] text-faint">{MODES.find((m) => m.value === p.mode)!.hint}</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-[12px] font-medium text-muted-foreground">
                Columns
                <span className="font-normal text-faint">Class labels are imported by name</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cfg.features.map((f) => {
                  const on = columns.includes(f.name);
                  return (
                    <button
                      key={f.name}
                      onClick={() => setColumns(on ? columns.filter((c) => c !== f.name) : cfg.features.map((x) => x.name).filter((x) => x === f.name || columns.includes(x)))}
                      title={f.labels ? `Labels: ${f.labels.join(", ")}` : f.kind}
                      className={cn("inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 font-mono text-[12px] transition-colors", on ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground hover:text-foreground")}
                    >
                      {f.name}
                      <span className={cn("font-sans text-[10.5px]", on ? "opacity-75" : "text-faint")}>{f.labels ? `${f.labels.length} labels` : f.kind}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-[14rem] flex-1">
                <Input value={name} onChange={setName} placeholder="Dataset name" />
              </div>
              {chosen.length > 1 && (
                <Segmented
                  value={combine}
                  onChange={setCombine}
                  options={[
                    { value: "one", label: "One dataset + split column" },
                    { value: "each", label: "One per split" },
                  ]}
                />
              )}
            </div>

            {importing && (
              <div className="space-y-1">
                <div className="flex justify-between text-[12px] text-muted-foreground tnum">
                  <span>{progress ? `${progress.label}${progress.parts > 1 ? ` (${progress.part + 1} of ${progress.parts})` : ""}` : "Starting…"}</span>
                  {progress && <span>{progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows</span>}
                </div>
                <Progress value={progress ? progress.done / Math.max(1, progress.total) : 0} indeterminate={!progress} />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
