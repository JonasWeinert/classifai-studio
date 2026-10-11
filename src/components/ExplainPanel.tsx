// "Why this answer?" on a Playground result: set up a removal test (how finely to split the input,
// with the time and cost it adds), run it, and show the input with the pieces that mattered marked.
import { cn } from "@/lib/utils";
import { Quote, ScanSearch, Square } from "lucide-react";
import { matchQuote } from "../lib/quoteMatch";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimate,
  explain,
  GRANULARITIES,
  MAX_PIECES,
  split,
  type Explanation,
  type Granularity,
  type PieceEffect,
} from "../lib/explain";
import { ms, pct, usd } from "../lib/format";
import { load, save } from "../lib/persist";
import { headline } from "../lib/questionDraft";
import type { AnyQuestion, QuickResult } from "../lib/types";
import { Button, Progress, Switch, Term } from "./ui";

/** Effects smaller than this (in probability) are not marked: noise, not evidence. */
const NOISE = 0.01;
/** Inputs this long (characters or pieces) show only the strongest pieces, as excerpts, until "Full text" is on. */
const LONG_CHARS = 600;
const LONG_PIECES = 40;
const TOP_LONG = 3;
/** Above this chance of the answer, evidence against it is hidden until "Contradicting" is on. */
const HIDE_AGAINST_ABOVE = 0.75;
/** Characters of context around an excerpt. */
const CONTEXT = 70;

export function ExplainPanel({
  model,
  text,
  questions,
  titles,
  result: full,
  color,
}: {
  model: string;
  text: string;
  questions: Record<string, AnyQuestion>;
  titles: Record<string, string>;
  result: QuickResult;
  color: string;
}) {
  // Only the questions asked about the input as it is (follow-ups saw earlier answers too).
  const result = useMemo(
    () => ({
      ...full,
      answers: Object.fromEntries(
        Object.entries(full.answers).filter(([id]) => id in questions),
      ),
    }),
    [full, questions],
  );
  const skipsFollowUps =
    Object.keys(full.answers).length > Object.keys(result.answers).length;
  const [open, setOpen] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>(() =>
    load<Granularity>("explain-granularity", "sentence"),
  );
  const [ex, setEx] = useState<Explanation | null>(null);
  const signal = useRef({ stopped: false });
  useEffect(() => save("explain-granularity", granularity), [granularity]);
  useEffect(() => () => void (signal.current.stopped = true), []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        GRANULARITIES.map((g) => [g.value, split(text, g.value).length]),
      ) as Record<Granularity, number>,
    [text],
  );
  const pieces = counts[granularity];
  const est = estimate(model, result, pieces);
  const cloud = model.startsWith("@");

  const start = async () => {
    signal.current = { stopped: false };
    await explain({
      model,
      text,
      questions,
      base: result,
      granularity,
      signal: signal.current,
      onUpdate: setEx,
    });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ScanSearch className="size-3.5" />
        Why this answer?
      </button>
    );
  }

  const setup = !ex || (!ex.running && ex.granularity !== granularity);
  return (
    <div className="mt-3 rounded-[12px] border border-border bg-background/60 p-3 fade-up">
      <div className="mb-2 flex items-center gap-2">
        <ScanSearch className="size-3.5 text-muted-foreground" />
        <span className="text-[12.5px] font-semibold">Why this answer?</span>
        <div className="flex-1" />
        <button
          onClick={() => ((signal.current.stopped = true), setOpen(false))}
          className="text-[11.5px] text-faint hover:text-foreground"
        >
          Close
        </button>
      </div>

      {setup ? (
        <Setup
          granularity={granularity}
          onGranularity={setGranularity}
          pieces={pieces}
          counts={counts}
          est={est}
          cloud={cloud}
          latency={result.latency_ms}
          onStart={start}
        />
      ) : (
        <>
          {skipsFollowUps && (
            <p className="mb-2 text-[11px] text-faint">
              Covers the first pass; follow-up questions are left out, since
              they also saw earlier answers.
            </p>
          )}
          <Result
            ex={ex!}
            text={text}
            result={result}
            titles={titles}
            color={color}
            onStop={() => (signal.current.stopped = true)}
            onAgain={() => setEx(null)}
            truncated={result.state_truncated}
          />
        </>
      )}
    </div>
  );
}

function Setup({
  granularity,
  onGranularity,
  pieces,
  counts,
  est,
  cloud,
  latency,
  onStart,
}: {
  granularity: Granularity;
  onGranularity: (g: Granularity) => void;
  pieces: number;
  counts: Record<Granularity, number>;
  est: ReturnType<typeof estimate>;
  cloud: boolean;
  latency: number;
  onStart: () => void;
}) {
  const tooMany = pieces > MAX_PIECES;
  const slow = est.ms > 60_000;
  return (
    <div className="space-y-2.5">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Each piece of the input is left out once and the same questions are
        asked again. Pieces whose removal lowers the chance of this answer are
        what it rested on.
      </p>
      <div>
        <div className="mb-1.5 text-[12px] text-muted-foreground">
          Leave out one at a time
        </div>
        <div className="flex flex-wrap gap-1">
          {GRANULARITIES.map((g) => {
            const n = counts[g.value];
            const on = g.value === granularity;
            return (
              <button
                key={g.value}
                onClick={() => onGranularity(g.value)}
                title={g.hint}
                className={cn(
                  "inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors",
                  on
                    ? "bg-foreground text-background"
                    : "bg-sel text-muted-foreground hover:text-foreground",
                )}
              >
                {g.label}
                <span
                  className={cn(
                    "font-mono text-[10.5px] tnum",
                    on ? "opacity-70" : "text-faint",
                  )}
                >
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-1 text-[11px] text-faint">
          Numbers are requests. Finer splits point at exact words but take
          longer.
        </div>
      </div>
      <div
        className={cn(
          "rounded-[8px] px-2.5 py-2 text-[12px]",
          tooMany || slow
            ? "bg-warn-soft text-warn"
            : "bg-sel text-muted-foreground",
        )}
      >
        <b className="font-medium text-foreground">{pieces}</b> piece
        {pieces === 1 ? "" : "s"} → {pieces} extra request
        {pieces === 1 ? "" : "s"}, about{" "}
        <b className="font-medium text-foreground">
          {ms(est.ms).replace(/\.\d+ s$/, " s")}
        </b>
        {cloud && est.cost > 0 && (
          <>
            {" "}
            and{" "}
            <b className="font-medium text-foreground">
              {usd(est.cost).startsWith("<")
                ? usd(est.cost)
                : `~${usd(est.cost)}`}
            </b>
          </>
        )}
        <span className="text-faint">
          {" "}
          · {pieces}× this answer ({ms(latency)}), {est.parallel} at a time
        </span>
        {tooMany && (
          <div className="mt-1">
            That's a lot of requests — a coarser split (sentences or paragraphs)
            gives a clearer picture faster.
          </div>
        )}
        {!tooMany && slow && (
          <div className="mt-1">
            This will take a while; it keeps running if you look at other
            results, and you can stop it any time.
          </div>
        )}
      </div>
      <Button variant="primary" onClick={onStart} disabled={pieces === 0}>
        Explain
      </Button>
    </div>
  );
}

function Result({
  ex,
  text,
  result,
  titles,
  color,
  truncated,
  onStop,
  onAgain,
}: {
  ex: Explanation;
  text: string;
  result: QuickResult;
  titles: Record<string, string>;
  color: string;
  truncated: boolean;
  onStop: () => void;
  onAgain: () => void;
}) {
  const ids = Object.keys(result.answers);
  const [qid, setQid] = useState(ids[0]);
  const answer = result.answers[qid];
  const label = answer ? headline(answer) : "";
  const base = ex.base[qid] ?? 0;
  const deltas = ex.pieces
    .map((p) => p.delta[qid])
    .filter((d): d is number => d !== undefined);
  const scale = Math.max(NOISE * 2, ...deltas.map(Math.abs));
  const failed = ex.pieces.filter((p) => p.error).length;
  const left = ex.done ? (ex.elapsedMs / ex.done) * (ex.total - ex.done) : null;

  const support = ex.pieces
    .filter((p) => (p.delta[qid] ?? 0) < -NOISE)
    .sort((a, b) => a.delta[qid] - b.delta[qid]);
  const against = ex.pieces
    .filter((p) => (p.delta[qid] ?? 0) > NOISE)
    .sort((a, b) => b.delta[qid] - a.delta[qid]);

  // Toggles: null follows the default (per question for contradictions), a click overrides it.
  const long = text.length > LONG_CHARS || ex.total > LONG_PIECES;
  const [fullText, setFullText] = useState(false);
  const [againstOn, setAgainstOn] = useState<boolean | null>(null);
  const showAgainst = againstOn ?? base <= HIDE_AGAINST_ABOVE;
  const brief = long && !fullText;
  // Pieces that get a mark: everything with an effect, or only the strongest few for a long input.
  const marked = useMemo(() => {
    const candidates = ex.pieces
      .map((p, i) => ({ i, d: p.delta[qid] }))
      .filter(
        (x): x is { i: number; d: number } =>
          x.d !== undefined && (x.d < -NOISE || (showAgainst && x.d > NOISE)),
      );
    if (brief)
      candidates.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).splice(TOP_LONG);
    return new Set(candidates.map((x) => x.i));
  }, [brief, ex.pieces, qid, showAgainst]);

  return (
    <div className="space-y-3">
      {ex.running ? (
        <div className="flex items-center gap-2.5">
          <Progress
            value={ex.done / Math.max(1, ex.total)}
            color={color}
            className="flex-1"
          />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tnum">
            {ex.done}/{ex.total}
            {left !== null && ` · ~${ms(left).replace(/\.\d+ s$/, " s")} left`}
          </span>
          <button
            onClick={onStop}
            className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <Square className="size-3" /> Stop
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
          <span>
            {ex.done < ex.total
              ? `Stopped after ${ex.done} of ${ex.total}`
              : `${ex.total} requests`}{" "}
            · {ms(ex.elapsedMs)}
            {ex.cost > 0 && ` · ${usd(ex.cost)}`}
            {failed > 0 && ` · ${failed} failed`}
          </span>
          <button
            onClick={onAgain}
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Try another split
          </button>
        </div>
      )}

      {ids.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <button
              key={id}
              onClick={() => setQid(id)}
              className={cn(
                "max-w-[14rem] truncate rounded-full px-2.5 py-0.5 text-[11.5px]",
                id === qid
                  ? "bg-foreground text-background"
                  : "bg-sel text-muted-foreground hover:text-foreground",
              )}
            >
              {titles[id] ?? id}
            </button>
          ))}
        </div>
      )}

      <div className="text-[12px] text-muted-foreground">
        Answer <b className="font-medium text-foreground">{label}</b> at{" "}
        <Term tip="The chance the model gives this answer with the whole input; each piece is compared against it.">
          {pct(base, 0)}
        </Term>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {long && (
          <Switch checked={fullText} onChange={setFullText} label="Full text" />
        )}
        <Switch
          checked={showAgainst}
          onChange={setAgainstOn}
          label="Contradicting"
        />
      </div>

      <Highlighted
        text={text}
        pieces={ex.pieces}
        qid={qid}
        scale={scale}
        color={color}
        label={label}
        base={base}
        marked={marked}
        brief={brief}
      />
      {brief && (
        <p className="text-[11px] text-faint">
          {marked.size
            ? `The ${marked.size === 1 ? "strongest piece" : `${marked.size} strongest pieces`} of a long input, in context.`
            : "No piece stands out yet."}{" "}
          Turn on Full text to see every mark.
        </p>
      )}

      <Legend color={color} label={label} against={showAgainst} />
      {!showAgainst && against.length > 0 && (
        <p className="text-[11px] text-faint">
          {against.length} piece{against.length === 1 ? "" : "s"} argue
          {against.length === 1 ? "s" : ""} against it, hidden because the
          answer is {pct(base, 0)} likely.
        </p>
      )}

      {!ex.running && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TopList
            title={`Most behind “${label}”`}
            items={support.slice(0, 3)}
            qid={qid}
            base={base}
            label={label}
            empty="Nothing stands out: no single piece moves the answer much — it rests on the text as a whole."
          />
          {showAgainst && (
            <TopList
              title="Most against it"
              items={against.slice(0, 3)}
              qid={qid}
              base={base}
              label={label}
              empty="Nothing in the input argues against it."
            />
          )}
        </div>
      )}

      {truncated && (
        <p className="text-[11.5px] text-warn">
          The input was cut off for this model, so pieces past the cut can't
          have mattered.
        </p>
      )}
      {!ex.running && (
        <p className="text-[11px] leading-relaxed text-faint">
          Pieces that say the same thing cover for each other: leaving one out
          barely matters while the other is still there. A coarser split catches
          that.
        </p>
      )}
    </div>
  );
}

const describe = (e: PieceEffect, qid: string, base: number, label: string) => {
  const d = e.delta[qid];
  if (e.error) return `Request failed: ${e.error}`;
  if (d === undefined) return "Not tested yet";
  return `Without this: ${label} ${pct(base, 0)} → ${pct(base + d, 0)}${e.flips[qid] ? " — the answer changes" : ""}`;
};

/**
 * The input with each marked piece shown by its effect; untested text stays faint. `brief`: only
 * excerpts around the marked pieces (merged when they overlap), for long inputs.
 */
function Highlighted({
  text,
  pieces,
  qid,
  scale,
  color,
  label,
  base,
  marked,
  brief,
}: {
  text: string;
  pieces: PieceEffect[];
  qid: string;
  scale: number;
  color: string;
  label: string;
  base: number;
  marked: Set<number>;
  brief: boolean;
}) {
  const ranges: [number, number][] = brief
    ? excerpts(
        text,
        [...marked].map((i) => pieces[i].piece),
      )
    : [[0, text.length]];
  const render = ([from, to]: [number, number]) => {
    const parts: React.ReactNode[] = [];
    let at = from;
    pieces.forEach((e, i) => {
      if (e.piece.end <= from || e.piece.start >= to) return;
      if (e.piece.start > at) parts.push(text.slice(at, e.piece.start));
      const d = e.delta[qid];
      const on = marked.has(i);
      const strength =
        !on || d === undefined ? 0 : Math.min(1, Math.abs(d) / scale);
      const supports = d !== undefined && d < 0;
      parts.push(
        <span
          key={i}
          title={describe(e, qid, base, label)}
          className={cn(
            "rounded-[3px] transition-[background-color,box-shadow] duration-300 [box-decoration-break:clone]",
            d === undefined && !e.error && "text-faint",
            on && e.flips[qid] && "ring-1 ring-foreground/40",
          )}
          style={
            strength === 0
              ? undefined
              : supports
                ? {
                    backgroundColor: `color-mix(in srgb, ${color} ${Math.round(12 + strength * 50)}%, transparent)`,
                  }
                : {
                    textDecoration: "underline dashed",
                    textDecorationColor: `color-mix(in srgb, var(--bad) ${Math.round(35 + strength * 65)}%, transparent)`,
                    textDecorationThickness: `${1 + strength * 1.5}px`,
                    textUnderlineOffset: "3px",
                  }
          }
        >
          {text.slice(Math.max(from, e.piece.start), Math.min(to, e.piece.end))}
        </span>,
      );
      at = e.piece.end;
    });
    if (at < to) parts.push(text.slice(at, to));
    return parts;
  };
  if (brief) {
    if (!ranges.length) return null;
    return (
      <div className="space-y-1.5">
        {ranges.map((r) => (
          <div
            key={r[0]}
            className="whitespace-pre-wrap rounded-[8px] bg-card px-3 py-2 text-[13px] leading-[1.75]"
          >
            {r[0] > 0 && <span className="text-faint">…</span>}
            {render(r)}
            {r[1] < text.length && <span className="text-faint">…</span>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[8px] bg-card px-3 py-2.5 text-[13px] leading-[1.75]">
      {render(ranges[0])}
    </div>
  );
}

/** Windows of context around pieces, snapped to word boundaries, in text order, merged when they touch. */
function excerpts(
  text: string,
  pieces: { start: number; end: number }[],
): [number, number][] {
  const snapStart = (i: number) => {
    if (i <= 0) return 0;
    const sp = text.indexOf(" ", i);
    return sp === -1 || sp > i + 20 ? i : sp + 1;
  };
  const snapEnd = (i: number) => {
    if (i >= text.length) return text.length;
    const sp = text.lastIndexOf(" ", i);
    return sp === -1 || sp < i - 20 ? i : sp;
  };
  const windows = pieces
    .map(
      (p) =>
        [
          Math.min(p.start, snapStart(p.start - CONTEXT)),
          Math.max(p.end, snapEnd(p.end + CONTEXT)),
        ] as [number, number],
    )
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const w of windows) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([...w]);
  }
  return out.map(([a, b]): [number, number] => {
    // Trim surrounding whitespace so excerpts start and end on text.
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    return [a, b];
  });
}

function Legend({
  color,
  label,
  against,
}: {
  color: string;
  label: string;
  against: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-2.5 w-8 rounded-[3px]"
          style={{
            background: `linear-gradient(90deg, color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 62%, transparent))`,
          }}
        />
        supports “{label}”
      </span>
      {against && (
        <span className="inline-flex items-center gap-1.5">
          <span className="underline decoration-dashed underline-offset-[3px] [text-decoration-color:var(--bad)]">
            text
          </span>
          argues against it
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-[3px] px-1 ring-1 ring-foreground/40">
          text
        </span>
        removing it alone changes the answer
      </span>
      <span className="text-faint">Hover a piece for numbers.</span>
    </div>
  );
}

function TopList({
  title,
  items,
  qid,
  base,
  label,
  empty,
}: {
  title: string;
  items: PieceEffect[];
  qid: string;
  base: number;
  label: string;
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11.5px] font-medium text-muted-foreground">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="text-[11.5px] text-faint">{empty}</div>
      ) : (
        <ol className="space-y-1">
          {items.map((e, i) => (
            <li
              key={i}
              className="flex items-baseline gap-2 text-[12px]"
              title={describe(e, qid, base, label)}
            >
              <span className="min-w-0 flex-1 truncate">“{e.piece.text}”</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground tnum">
                {e.delta[qid] > 0 ? "+" : "−"}
                {Math.abs(Math.round(e.delta[qid] * 100))} pts
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * "Why this answer?" for an LLM: no removal test — the model quoted, for every answer, the passage
 * of the input it rests on. Each quote is found in the input (allowing small changes) and shown
 * there; one that can't be found is shown as the model wrote it.
 */
export function QuoteExplain({ text, titles, result, color }: { text: string; titles: Record<string, string>; result: QuickResult; color: string }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(
    () =>
      Object.entries(result.answers).map(([id, a]) => {
        const quote = result.quotes?.[id]?.trim() ?? "";
        return { id, a, quote, match: quote ? matchQuote(text, quote) : null };
      }),
    [result, text],
  );
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground">
        <Quote className="size-3.5" />
        Why this answer?
      </button>
    );
  }
  return (
    <div className="mt-3 rounded-[12px] border border-border bg-background/60 p-3 fade-up">
      <div className="mb-1 flex items-center gap-2">
        <Quote className="size-3.5 text-muted-foreground" />
        <span className="text-[12.5px] font-semibold">Why this answer?</span>
        <button onClick={() => setOpen(false)} className="ml-auto text-[11.5px] text-faint hover:text-foreground">
          Hide
        </button>
      </div>
      <p className="mb-2.5 text-[11.5px] leading-snug text-faint">
        The passage the LLM quoted as support for each answer, found in the input. It shows what the model points to, not a measured effect — it costs nothing extra, but a model can quote a passage that didn't drive its answer.
      </p>
      <div className="space-y-2.5">
        {items.map(({ id, a, quote, match }) => (
          <div key={id}>
            <div className="mb-0.5 flex items-baseline gap-1.5 text-[11.5px]">
              <span className="min-w-0 truncate text-muted-foreground">{titles[id] ?? id}</span>
              <span className="shrink-0 font-medium">→ {headline(a)}</span>
            </div>
            {!quote ? (
              <div className="text-[12px] text-faint italic">No supporting passage given.</div>
            ) : match ? (
              <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {match.start > CONTEXT ? "…" : ""}
                {text.slice(Math.max(0, match.start - CONTEXT), match.start)}
                <mark className="rounded-[3px] text-inherit [box-decoration-break:clone]" style={{ background: `color-mix(in srgb, ${color} 28%, transparent)` }}>
                  {text.slice(match.start, match.end)}
                </mark>
                {text.slice(match.end, match.end + CONTEXT)}
                {match.end + CONTEXT < text.length ? "…" : ""}
                {!match.exact && (
                  <span className="ml-1.5 text-[11px] text-faint" title={`The model quoted: “${quote}”`}>
                    · close match ({pct(match.score, 0)} of the words)
                  </span>
                )}
              </div>
            ) : (
              <div className="text-[12px] leading-snug">
                <span className="text-muted-foreground italic">“{quote}”</span>
                <span className="ml-1.5 text-[11px] text-warn">not found in the input — likely paraphrased</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
