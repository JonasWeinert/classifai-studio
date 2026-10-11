// How one answer looks in full: headline, confidence and the distribution behind it, per question type.
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import { topChance } from "../lib/answers";
import { pct } from "../lib/format";
import { GLOSSARY, sureness, yesNoWords } from "../lib/glossary";
import { matchesExpected } from "../lib/infer";
import { fmt, headline } from "../lib/questionDraft";
import type { AnyAnswer } from "../lib/types";
import { ProbBars } from "./charts";
import { Term } from "./ui";

export function AnswerView({ title, a, color, expected }: { title?: string; a: AnyAnswer; color: string; expected?: string }) {
  const match = expected !== undefined ? matchesExpected(a, expected) : null;
  // A written answer (LLMs): the text itself, no distribution.
  if (a.type === "text") {
    return (
      <div>
        {title && <div className="mb-0.5 truncate text-[11.5px] text-muted-foreground">{title}</div>}
        <div className="rounded-r-[8px] border-l-2 py-0.5 pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ borderColor: color }}>
          {a.text}
        </div>
        {expected !== undefined && expected.trim() && (
          <div className="mt-1.5 text-[11.5px] text-faint">
            dataset: <span className="text-muted-foreground">{expected}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      {title && <div className="mb-0.5 truncate text-[11.5px] text-muted-foreground">{title}</div>}
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-[-0.01em]">{headline(a)}</span>
        {"confidence" in a && (
          <span className="text-[12px] text-muted-foreground">
            <Term tip={GLOSSARY.confidence}>
              {pct(topChance(a), 0)} likely · {sureness(a.confidence)}
            </Term>
          </span>
        )}
        {a.type === "noul" && (
          <span className="text-[12px] text-muted-foreground">
            <Term tip={GLOSSARY.chanceYes}>{pct(a.noul, 0)} chance of yes</Term>
            <span className="text-faint"> · {yesNoWords(a.noul)}</span>
          </span>
        )}
        {a.type === "score" && (
          <Term tip={GLOSSARY.score} className="font-mono text-[11.5px] text-faint">
            score {a.score.toFixed(2)}
          </Term>
        )}
        {expected !== undefined && (
          <span
            title="This row's value in the dataset"
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-1 self-center rounded-full px-2 py-px text-[11.5px]",
              match === true ? "bg-good-soft text-good" : match === false ? "bg-bad-soft text-bad" : "bg-sel text-muted-foreground",
            )}
          >
            {match === true ? <Check className="size-3" /> : match === false ? <X className="size-3" /> : null}
            dataset: <b className="font-medium">{expected || "—"}</b>
          </span>
        )}
      </div>

      {a.type === "choice" && <ProbBars probs={a.probabilities} highlight={a.choice} color={color} />}
      {a.type === "score" && <ProbBars probs={a.probabilities} highlight={String(Math.round(a.score))} color={color} legend={a.legend} />}

      {a.type === "noul" && (
        <div className="space-y-1">
          <div className="relative h-2 overflow-hidden rounded-full bg-sel">
            <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${a.noul * 100}%`, background: color }} />
            <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/25" />
          </div>
          <div className="flex justify-between text-[11px] text-faint">
            <span>certainly no</span>
            <span>50/50</span>
            <span>certainly yes</span>
          </div>
        </div>
      )}

      {a.type === "multi" && (
        <div className="space-y-1.5">
          <div className="text-[11.5px] text-faint">
            <Term tip={GLOSSARY.multi}>Each option judged on its own</Term> · selected at{" "}
            <Term tip={GLOSSARY.threshold}>{pct(a.threshold, 0)} or more</Term> (the line)
          </div>
          {Object.entries(a.probabilities).map(([k, v]) => {
            const on = a.selected.includes(k);
            return (
              <div key={k} className="grid grid-cols-[minmax(0,9rem)_1fr_3.2rem] items-center gap-2.5 text-[12.5px]">
                <div className={cn("truncate", on ? "font-semibold" : "text-muted-foreground")}>{k}</div>
                <div className="relative h-2 overflow-hidden rounded-full bg-sel">
                  <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${v * 100}%`, background: on ? color : "var(--border-strong)" }} />
                  <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${a.threshold * 100}%` }} title={`Selected at ${pct(a.threshold, 0)} or more`} />
                </div>
                <div className={cn("text-right font-mono text-[11px] tnum", on ? "text-foreground" : "text-faint")}>{pct(v, 0)}</div>
              </div>
            );
          })}
        </div>
      )}

      {a.type === "rank" && (
        <ol className="space-y-1" title={GLOSSARY.rank}>
          {a.ranking.map((k, i) => (
            <li key={k} className="grid grid-cols-[1.25rem_minmax(0,9rem)_1fr_3.2rem] items-center gap-2 text-[12.5px]">
              <span className="font-mono text-[11px] text-faint">{i + 1}</span>
              <span className={cn("truncate", i === 0 ? "font-semibold" : "text-muted-foreground")}>{k}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-sel">
                <div className="h-full rounded-full" style={{ width: `${a.probabilities[k] * 100}%`, background: i === 0 ? color : "var(--border-strong)" }} />
              </div>
              <span className="text-right font-mono text-[11px] text-faint tnum">{pct(a.probabilities[k], 0)}</span>
            </li>
          ))}
        </ol>
      )}

      {a.type === "number" && <NumberView a={a} color={color} />}
    </div>
  );
}

function NumberView({ a, color }: { a: Extract<AnyAnswer, { type: "number" }>; color: string }) {
  const entries = Object.entries(a.probabilities);
  const max = Math.max(...entries.map(([, v]) => v), 1e-9);
  return (
    <div>
      <div className="mb-2 text-[12px] text-muted-foreground">
        <Term tip={GLOSSARY.mostLikely}>most likely</Term> <b className="text-foreground">{fmt(a.most_likely)}</b> · <Term tip={GLOSSARY.range80}>80% range</Term>{" "}
        <b className="text-foreground">
          {fmt(a.range[0])}–{fmt(a.range[1])}
        </b>
        {a.unit ? ` ${a.unit}` : ""}
      </div>
      <div className="flex h-16 items-end gap-1">
        {entries.map(([k, v]) => {
          const inRange = Number(k) >= a.range[0] && Number(k) <= a.range[1];
          return (
            <div key={k} className="flex flex-1 flex-col items-center gap-1" title={`${k}: ${pct(v)}`}>
              <div className="w-full rounded-t-[3px] transition-[height] duration-500 ease-out" style={{ height: `${(v / max) * 48}px`, background: inRange ? color : "var(--border-strong)", opacity: inRange ? 1 : 0.7 }} />
              <span className="font-mono text-[10px] text-faint">{k}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
