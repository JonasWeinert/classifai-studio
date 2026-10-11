// Bulk results: a summary per question, then one table row per entry. Rows expand to the full
// entry and every answer's distribution.
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { certainty, topChance, UNSURE } from "../lib/answers";
import { describeError } from "../lib/errors";
import { modelColor, ms, pct, usd } from "../lib/format";
import { consensusKey, headline } from "../lib/questionDraft";
import type { AnyAnswer, BulkRowData } from "../lib/types";
import { AnswerView } from "./AnswerView";
import { Button, Input, Progress, Segmented } from "./ui";

export type BulkRow = BulkRowData;

/** Has this entry been answered (or did it fail)? `error` is null in stored rows without one. */
export const isDone = (r: BulkRow) => !!r.answers || hasError(r);
export const hasError = (r: BulkRow) => r.error !== undefined && r.error !== null;

type Show = "all" | "unsure" | "errors";

/** The value an answer is grouped and filtered by: the scale's label, otherwise what "agreeing" means. */
const groupKey = (a: AnyAnswer) => (a.type === "score" ? headline(a) : consensusKey(a));
const PAGE = 50;

export function BulkResults({ rows, titles, running, className }: { rows: BulkRow[]; titles: Record<string, string>; running: boolean; className?: string }) {
  const run = { titles };
  const ids = Object.keys(titles);
  const [show, setShow] = useState<Show>("all");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<{ id: string; value: string } | null>(null);
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const done = rows.filter(isDone).length;
  const errors = rows.filter(hasError).length;
  const unsure = (r: BulkRow) => !!r.answers && ids.some((id) => r.answers![id] && certainty(r.answers![id]) < UNSURE);
  const unsureCount = rows.filter(unsure).length;
  const cost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
  const lat = rows.map((r) => r.latency).filter((x): x is number => x != null).sort((a, b) => a - b);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (show === "errors" && !hasError(r)) return false;
      if (show === "unsure" && !unsure(r)) return false;
      if (pick && (!r.answers?.[pick.id] || groupKey(r.answers[pick.id]) !== pick.value)) return false;
      return !q || r.input.toLowerCase().includes(q);
    });
    if (sort) {
      const key = (r: BulkRow) => (r.answers?.[sort.id] ? certainty(r.answers[sort.id]) : sort.desc ? -1 : 2);
      out = [...out].sort((a, b) => (key(a) - key(b)) * (sort.desc ? -1 : 1));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, show, search, pick, sort]);
  useEffect(() => setPage(0), [show, search, pick, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const visible = shown.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className={className}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        <span>
          <b className="text-[15px] font-semibold text-foreground tnum">{done.toLocaleString()}</b> of {rows.length.toLocaleString()} answered
        </span>
        {errors > 0 && <span className="text-bad tnum">{errors.toLocaleString()} failed</span>}
        {unsureCount > 0 && <span className="text-warn tnum">{unsureCount.toLocaleString()} unsure</span>}
        <span className="ml-auto tnum">
          {lat.length > 0 && `median ${ms(lat[Math.floor(lat.length / 2)])}`}
          {cost > 0 && ` · ${usd(cost)}`}
        </span>
      </div>
      {running && <Progress value={done / Math.max(1, rows.length)} className="-mt-2 mb-4" />}

      <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
        {ids.map((id) => (
          <QuestionSummary key={id} id={id} title={run.titles[id]} rows={rows} active={pick?.id === id ? pick.value : null} onPick={(value) => setPick(value === null || (pick?.id === id && pick.value === value) ? null : { id, value })} />
        ))}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: "All" },
            { value: "unsure", label: `Unsure${unsureCount ? ` · ${unsureCount}` : ""}` },
            { value: "errors", label: `Failed${errors ? ` · ${errors}` : ""}` },
          ]}
        />
        {pick && (
          <button onClick={() => setPick(null)} className="inline-flex h-[26px] items-center gap-1 rounded-full bg-primary/12 px-2.5 text-[12px] text-primary">
            <span className="max-w-40 truncate">{run.titles[pick.id]}</span> = <b className="font-semibold">{pick.value}</b>
            <X className="size-3" />
          </button>
        )}
        <div className="relative ml-auto w-56">
          <Input value={search} onChange={setSearch} placeholder="Search entries" />
          {!search && <Search className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" />}
        </div>
      </div>

      <div className="overflow-x-auto rounded-[14px] bg-card" data-selectable>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="text-left text-[11.5px] text-muted-foreground">
              <th className="w-12 px-3 py-2.5 font-mono font-medium text-faint">#</th>
              <th className="min-w-[16rem] px-3 py-2.5 font-medium">Entry</th>
              {ids.map((id) => {
                const sorted = sort?.id === id;
                return (
                  <th key={id} className="min-w-[8.5rem] px-3 py-2.5 font-medium" aria-sort={sorted ? (sort!.desc ? "descending" : "ascending") : "none"}>
                    <button
                      title={`${run.titles[id]} — click to sort by confidence`}
                      onClick={() => setSort(!sorted ? { id, desc: false } : !sort!.desc ? { id, desc: true } : null)}
                      className={cn("inline-flex max-w-[13rem] items-center gap-1 text-left hover:text-foreground", sorted && "text-foreground")}
                    >
                      <span className="line-clamp-2">{run.titles[id]}</span>
                      {sorted && (sort!.desc ? <ArrowDown className="size-3 shrink-0" /> : <ArrowUp className="size-3 shrink-0" />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const isOpen = open === r.pos;
              return (
                <Fragment key={r.pos}>
                  <tr onClick={() => setOpen(isOpen ? null : r.pos)} className={cn("cursor-default border-t border-border align-top transition-colors hover:bg-sel/50", isOpen && "bg-sel/50")}>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-faint tnum">{r.idx + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="max-w-[30rem]">
                        <EntryCell r={r} />
                      </div>
                    </td>
                    {hasError(r) ? (
                      <td colSpan={ids.length} className="px-3 py-2.5 text-[12px] text-bad">
                        {describeError(r.error).message}
                      </td>
                    ) : (
                      ids.map((id) => (
                        <td key={id} className="px-3 py-2.5">
                          {r.answers ? r.answers[id] ? <AnswerCell a={r.answers[id]} /> : <span className="text-faint">—</span> : running ? <div className="h-[30px] w-20 rounded-[6px] shimmer" /> : <span className="text-[12px] text-faint">not run</span>}
                        </td>
                      ))
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="bg-sel/50">
                      <td />
                      <td colSpan={ids.length + 1} className="px-3 pt-1 pb-5">
                        <RowDetail r={r} ids={ids} titles={run.titles} running={running} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">No entries match.</div>}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px] text-muted-foreground tnum">
          {page * PAGE + 1}–{Math.min(shown.length, page * PAGE + PAGE)} of {shown.length.toLocaleString()}
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** One entry: a single column as text; several as a lead line and the rest beneath. */
function EntryCell({ r }: { r: BulkRow }) {
  const fields = r.fields ? Object.entries(r.fields).filter(([, v]) => v.trim()) : [];
  if (fields.length <= 1) {
    return (
      <div className="line-clamp-2 leading-snug" title={r.input}>
        {fields[0]?.[1] ?? r.input}
      </div>
    );
  }
  const [[, lead], ...rest] = fields;
  return (
    <div className="min-w-0 leading-snug" title={r.input}>
      <div className="truncate font-medium">{lead}</div>
      <div className="line-clamp-1 text-muted-foreground">{rest.map(([, v]) => v).join(" · ")}</div>
    </div>
  );
}

/** Answer and a small confidence meter; unsure answers are marked. */
function AnswerCell({ a }: { a: AnyAnswer }) {
  if (a.type === "text") {
    return (
      <div className="line-clamp-3 max-w-[16rem] text-[12.5px] leading-snug" title={a.text}>
        {a.text}
      </div>
    );
  }
  const c = certainty(a);
  const low = c < UNSURE;
  // Shown: the chance of the answer itself (matches the Playground's bars); `c` only flags unsure answers.
  const shown = topChance(a);
  const label = headline(a);
  return (
    <div className="min-w-0 max-w-[14rem]" title={`${label} · ${a.type === "noul" ? `${pct(a.noul, 0)} chance of yes` : `${pct(shown, 0)} likely`}`}>
      <div className={cn("truncate font-medium", a.type === "multi" && !a.selected.length && "font-normal text-muted-foreground")}>{label}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <div className="h-[3px] w-12 overflow-hidden rounded-full bg-sel">
          <div className={cn("h-full rounded-full", low ? "bg-warn" : "bg-primary/60")} style={{ width: `${shown * 100}%` }} />
        </div>
        <span className={cn("font-mono text-[10.5px] tnum", low ? "text-warn" : "text-faint")}>{pct(shown, 0)}</span>
      </div>
    </div>
  );
}

function RowDetail({ r, ids, titles, running }: { r: BulkRow; ids: string[]; titles: Record<string, string>; running: boolean }) {
  const fields = r.fields ? Object.entries(r.fields) : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 fade-up">
      <div className="min-w-0">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Entry</div>
        {fields && fields.length > 1 ? (
          <dl className="space-y-2.5">
            {fields.map(([k, v]) => (
              <div key={k}>
                <dt className="font-mono text-[11px] text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 leading-relaxed whitespace-pre-wrap">{v || <span className="text-faint">empty</span>}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="leading-relaxed whitespace-pre-wrap">{r.input}</p>
        )}
        {r.latency != null && (
          <div className="mt-3 font-mono text-[11px] text-faint">
            {ms(r.latency)}
            {!!r.cost && ` · ${usd(r.cost)}`}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-4">
        {r.answers ? (
          ids.map((id) => (r.answers![id] ? <AnswerView key={id} title={titles[id]} a={r.answers![id]} color={modelColor(0)} /> : null))
        ) : hasError(r) ? (
          <div className="text-bad">{describeError(r.error).message}</div>
        ) : (
          <div className="text-faint">{running ? "Waiting…" : "Not run: the run was stopped first."}</div>
        )}
      </div>
    </div>
  );
}

/** How the answers to one question are spread; click a value to filter the table. */
function QuestionSummary({ id, title, rows, active, onPick }: { id: string; title: string; rows: BulkRow[]; active: string | null; onPick: (value: string | null) => void }) {
  const { top, rest, total, unsure } = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0, unsure = 0;
    for (const r of rows) {
      const a = r.answers?.[id];
      if (!a) continue;
      total++;
      if (certainty(a) < UNSURE) unsure++;
      const k = groupKey(a);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return { top: sorted.slice(0, 4), rest: sorted.slice(4).reduce((a, [, n]) => a + n, 0), total, unsure };
  }, [rows, id]);
  return (
    <div className="rounded-[14px] bg-card px-3.5 pt-3 pb-3">
      <div className="mb-2 line-clamp-2 text-[12px] font-medium leading-snug" title={`${title} (${id})`}>
        {title}
      </div>
      {total === 0 ? (
        <div className="h-16 rounded-[8px] shimmer" />
      ) : (
        <div className="space-y-1">
          {top.map(([value, n]) => (
            <button key={value} onClick={() => onPick(value)} className={cn("grid w-full grid-cols-[minmax(0,1fr)_3.5rem_2.2rem] items-center gap-2 rounded-[5px] px-1 py-0.5 text-left text-[12px] hover:bg-sel", active === value && "bg-primary/10")}>
              <span className={cn("truncate", active === value ? "font-semibold text-primary" : "text-foreground")}>{value}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-sel">
                <span className="block h-full rounded-full bg-primary/60" style={{ width: `${(n / total) * 100}%` }} />
              </span>
              <span className="text-right font-mono text-[11px] text-muted-foreground tnum">{n}</span>
            </button>
          ))}
          {(rest > 0 || unsure > 0) && (
            <div className="flex justify-between px-1 pt-0.5 text-[11px] text-faint">
              <span>{rest > 0 ? `+${rest} other` : ""}</span>
              {unsure > 0 && <span className="text-warn">{unsure} unsure</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
