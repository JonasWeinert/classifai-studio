import clsx from "clsx";
import { Panes } from "../components/Panes";
import { ArrowDown, ArrowUp, ChartColumnBig, Link2, ChevronLeft, ChevronRight, FlaskConical, Pencil, Search, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Distribution } from "../components/charts";
import { Badge, Button, CardHeader, ErrorNote, Input, Modal, PageHeader, Spinner, Tooltip } from "../components/ui";
import { api, errorMessage, fileSrc } from "../lib/api";
import { isImageUrl } from "../lib/labelling";
import { useApp, useAsync } from "../lib/app";
import { guessLabelColumn } from "../lib/columns";
import { ago, pct } from "../lib/format";
import type { Row, ValueCount } from "../lib/types";
import { OpenRowModal } from "../components/OpenRowModal";

const PAGE = 50;

export function DatasetDetail({ id }: { id: string }) {
  const { go, toast } = useApp();
  const ds = useAsync(() => api.dataset(id), [id]);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const rows = useAsync(() => api.datasetRows(id, offset, PAGE, { search: search || undefined, sortColumn: sort?.column, sortDesc: sort?.desc }), [id, offset, search, sort?.column, sort?.desc]);
  const exps = useAsync(() => api.experiments(id), [id]);
  const corrections = useAsync(() => api.corrections(id), [id]);
  const derived = useAsync(() => api.datasets().then((all) => all.filter((x) => x.parent_id === id)), [id]);
  const [column, setColumn] = useState<string | null>(null);
  const [counts, setCounts] = useState<ValueCount[] | null>(null);
  const [distinctAll, setDistinctAll] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [opening, setOpening] = useState<[number, Row] | null>(null);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const isRenaming = renaming !== null;
  useEffect(() => {
    if (isRenaming) requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#dataset-rename input")?.select());
  }, [isRenaming]);

  const d = ds.data;
  useEffect(() => {
    if (d && !column) setColumn(guessLabelColumn(d.columns));
  }, [d, column]);
  useEffect(() => {
    if (!column) return;
    setCounts(null);
    api
      .columnProfile(id, column, 300)
      .then((p) => {
        setCounts(p.top);
        setDistinctAll(p.distinct);
      })
      .catch(() => setCounts([]));
  }, [id, column]);

  if (ds.error) return <ErrorNote error={ds.error} />;
  if (!d) return <Spinner />;

  const distinct = distinctAll;
  const looksCategorical = counts && distinct >= 2 && distinct <= 255 && distinct < d.row_count * 0.5;
  const total = rows.data?.total ?? d.row_count;
  const added = new Set(d.added_columns ?? []);

  const toggleSort = (c: string) => {
    setOffset(0);
    setSort((s) => (s?.column !== c ? { column: c, desc: false } : !s.desc ? { column: c, desc: true } : null));
  };

  const rename = async () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (!name || name === d.name) return;
    try {
      await api.datasetRename(id, name);
      ds.setData({ ...d, name });
      toast(`Renamed to ${name}`, "good");
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <>
      <PageHeader
        back={{ label: "Datasets", onClick: () => go({ page: "datasets" }) }}
        title={
          renaming !== null ? (
            <form
              id="dataset-rename"
              className="-my-1 max-w-sm font-normal"
              onSubmit={(e) => {
                e.preventDefault();
                rename();
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) rename();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(null);
              }}
            >
              <Input autoFocus value={renaming} onChange={setRenaming} />
            </form>
          ) : (
            <Tooltip content="Click to rename" side="bottom">
              <button onClick={() => setRenaming(d.name)} onDoubleClick={() => setRenaming(d.name)} className="group/title inline-flex max-w-full items-center gap-1.5 rounded-[6px] text-left hover:text-foreground">
                <span className="truncate">{d.name}</span>
                <Pencil className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover/title:opacity-100" />
              </button>
            </Tooltip>
          )
        }
        subtitle={
          <span className="tnum">
            {d.row_count.toLocaleString()} rows · {d.columns.length} columns · {d.parent_id ? "saved" : "imported"} {ago(d.created_at)}
            {d.parent_id ? (
              <button className="ml-2 inline-flex items-center gap-1 hover:text-foreground hover:underline" onClick={() => go({ page: "dataset", id: d.parent_id! })}>
                <Link2 className="size-3" /> linked to {d.parent_name}
              </button>
            ) : (
              d.source && <span className="ml-2 font-mono text-[11.5px] text-faint">{d.source}</span>
            )}
          </span>
        }
        actions={
          <>
            <div className="relative w-52">
              <Input value={searchInput} onChange={setSearchInput} placeholder="Search rows" />
              {!searchInput && <Search className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" />}
            </div>
            <Tooltip content="Delete dataset" side="bottom">
              <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)} />
            </Tooltip>
            <Button variant="primary" icon={<FlaskConical className="size-3.5" />} onClick={() => go({ page: "new-experiment", datasetId: id })}>
              New evaluation
            </Button>
          </>
        }
      />

      <Panes template="minmax(0,1fr) 300px" className="gap-10">
        <div className="min-w-0">
          <CardHeader
            className="px-0 pt-0"
            title={search ? `Rows matching “${search}”` : "Rows"}
            subtitle={
              total === 0
                ? "No matching rows"
                : `Showing ${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString()}${sort ? ` · sorted by ${sort.column} ${sort.desc ? "Z→A" : "A→Z"}` : ""}`
            }
            actions={
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            }
          />
          <div className={clsx("max-h-[600px] overflow-auto border-y border-border transition-opacity", rows.loading && "opacity-60")} data-selectable>
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-background">
                <tr>
                  <th className="border-b border-border px-3 py-2 text-left font-mono text-[11px] font-medium text-faint">#</th>
                  {d.columns.map((c) => {
                    const sorted = sort?.column === c;
                    return (
                      <th
                        key={c}
                        aria-sort={sorted ? (sort!.desc ? "descending" : "ascending") : "none"}
                        className={clsx("group/h whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium", c === column ? "text-primary" : "text-muted-foreground", added.has(c) && "bg-primary/[0.04]")}
                        title={added.has(c) ? "Stored in this dataset (the other columns are linked)" : undefined}
                      >
                        <span className="inline-flex items-center gap-1">
                          <Tooltip content={sorted ? (sort!.desc ? "Sorted Z→A · click to clear" : "Sorted A→Z · click for Z→A") : "Sort by this column"}>
                            <button onClick={() => toggleSort(c)} className="inline-flex items-center gap-1 hover:text-foreground">
                              {c}
                              {sorted && (sort!.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                            </button>
                          </Tooltip>
                          <Tooltip content={`Profile “${c}”`}>
                            <button
                              onClick={() => setColumn(c)}
                              aria-label={`Profile ${c}`}
                              className={clsx(
                                "grid size-5 place-items-center rounded-[5px] transition-opacity hover:bg-sel hover:text-foreground",
                                c === column ? "text-primary opacity-100" : "opacity-0 group-hover/h:opacity-100 focus-visible:opacity-100",
                              )}
                            >
                              <ChartColumnBig className="size-3.5" />
                            </button>
                          </Tooltip>
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.data?.rows.map(([i, r]) => (
                  <tr key={i} className="group hover:bg-sel/60">
                    <td className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-faint tnum">
                      <span className="flex items-center gap-1">
                        <span className="min-w-[2ch]">{i + 1}</span>
                        <Tooltip content="Open in Playground">
                          <button onClick={() => setOpening([i, r])} aria-label="Open in Playground" className="grid size-5 place-items-center rounded-[5px] opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-foreground focus-visible:opacity-100">
                            <SquareArrowOutUpRight className="size-3" />
                          </button>
                        </Tooltip>
                      </span>
                    </td>
                    {d.columns.map((c) => (
                      <td key={c} className={clsx("border-b border-border px-3 py-1.5", c === column && "bg-primary/5")} title={r[c]}>
                        {isImageUrl(r[c] ?? "") ? (
                          <span className="flex max-w-[340px] items-center gap-2">
                            <img src={fileSrc(r[c])} alt="" loading="lazy" className="size-8 shrink-0 rounded-[5px] bg-card object-cover" />
                            <span className="truncate font-mono text-[11px] text-muted-foreground">{r[c].startsWith("data:") ? "image" : r[c].split(/[\\/]/).pop()}</span>
                          </span>
                        ) : (
                          <div className="max-w-[340px] truncate">{r[c]}</div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.data && rows.data.rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">No rows match “{search}”.</div>}
          </div>
        </div>

        <div className="space-y-4">
          <div className="border-b border-border pb-5">
            <CardHeader
              className="px-0 pt-0"
              title={
                <span>
                  Column <span className="font-mono text-primary">{column}</span>
                </span>
              }
              subtitle={
                <span className="inline-flex items-center gap-1">
                  Use <ChartColumnBig className="inline size-3.5" /> on a header to profile another column.
                </span>
              }
            />
            <div>
              {!counts ? (
                <Spinner />
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <Badge>{distinct.toLocaleString()} distinct</Badge>
                    {looksCategorical ? <Badge tone="good">Looks like labels</Badge> : <Badge>Free text</Badge>}
                  </div>
                  <Distribution items={counts.slice(0, 12)} total={d.row_count} />
                  {distinct > 12 && (
                    <div className="mt-2 text-[11.5px] text-faint">
                      +{(distinct - 12).toLocaleString()} more values ({pct(1 - counts.slice(0, 12).reduce((a, c) => a + c.count, 0) / d.row_count)} of rows)
                    </div>
                  )}
                  {looksCategorical && (
                    <Button className="mt-4 w-full" variant="secondary" size="sm" onClick={() => go({ page: "new-experiment", datasetId: id })}>
                      Use as ground truth →
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="border-b border-border pb-4">
            <CardHeader className="px-0" title="Evaluations" subtitle={exps.data?.length ? undefined : "None yet"} />
            <div className="-mx-2">
              {exps.data?.map((e) => (
                <button key={e.id} onClick={() => go({ page: "experiment", id: e.id })} className="flex w-full items-center justify-between rounded-[6px] px-2 py-2 text-left hover:bg-sel">
                  <span className="truncate text-[12.5px] font-medium">{e.name}</span>
                  <span className="shrink-0 text-[11.5px] text-faint">{ago(e.created_at)}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <CardHeader
              className="px-0"
              title="Ground-truth corrections"
              subtitle={
                corrections.data?.length
                  ? `${corrections.data.length} row${corrections.data.length === 1 ? "" : "s"} reviewed by a human · used by every evaluation on this dataset`
                  : "None yet — confirm or relabel rows from an evaluation's predictions or review queue."
              }
            />
            {!!corrections.data?.length && (
              <div className="max-h-56 overflow-auto">
                <table className="w-full text-[12px]">
                  <tbody>
                    {corrections.data.slice(0, 50).map((c) => (
                      <tr key={`${c.row_idx}:${c.column}`} className="border-t border-border first:border-0">
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-faint tnum">#{c.row_idx + 1}</td>
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{c.column}</td>
                        <td className="py-1.5" title={c.note ?? undefined}>
                          {c.original === c.value ? (
                            <span className="text-good">✓ {c.value}</span>
                          ) : (
                            <span>
                              <span className="text-faint line-through">{c.original}</span> → <span className="font-medium">{c.value}</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Panes>

      <OpenRowModal dataset={d} row={opening} onClose={() => setOpening(null)} />

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete dataset?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                try {
                  await api.datasetDelete(id);
                  toast(`Deleted ${d.name}`);
                  go({ page: "datasets" });
                } catch (e) {
                  toast(errorMessage(e), "bad");
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          This removes <b className="text-foreground">{d.name}</b> and its {exps.data?.length ?? 0} evaluation(s) from ClassifAI Studio. The original file is not touched.
          {(derived.data?.length ?? 0) > 0 && ` ${derived.data!.length} dataset${derived.data!.length === 1 ? "" : "s"} saved from it (${derived.data!.map((x) => x.name).join(", ")}) keep their rows: the linked cells are copied into them.`}
        </p>
      </Modal>
    </>
  );
}
