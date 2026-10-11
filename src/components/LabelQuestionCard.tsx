// One question in the labelling workspace: its options as large, keyed buttons. The active
// question takes the keyboard (1–9 pick, Y/N for yes/no).
import { cn } from "@/lib/utils";
import { Check, Quote, RotateCcw, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Clamp } from "./Clamp";
import { choiceKey, isAnswered, tint, type LabelQuestion } from "../lib/labelling";
import { KINDS } from "../lib/questionDraft";
import type { LabelSnippet, LabelValue } from "../lib/types";

/** Options stack in a narrow card and go two (or three) up as the card widens (container queries on the card). */
const optionGrid = (n: number) => cn("grid gap-1.5", n >= 4 && "@[400px]:grid-cols-2", n >= 9 && "@[640px]:grid-cols-3");

function Key({ k, on }: { k: string | null; on?: boolean }) {
  if (!k) return <span className="w-5" />;
  return <kbd className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] font-mono text-[10.5px] font-medium uppercase transition-colors", on ? "bg-primary-foreground/25 text-primary-foreground" : "bg-sel text-muted-foreground")}>{k}</kbd>;
}

export const LabelQuestionCard = forwardRef<
  HTMLDivElement,
  {
    lq: LabelQuestion;
    index: number;
    value: LabelValue | undefined;
    active: boolean;
    onShowDetails: () => void;
    onActivate: () => void;
    onChange: (v: LabelValue | null) => void;
    /** Passages of the entry marked as context for this answer. */
    snippets?: LabelSnippet[];
    onRemoveSnippet?: (index: number) => void;
    /** Say how to add context (until the session has any). */
    contextHint?: boolean;
    /** The question's colour: ring, number and context passages. */
    color?: string;
    /** A follow-up: why it is shown, e.g. "#1 → No". */
    followUpOf?: string;
  }
>(function LabelQuestionCard({ lq, index, value, active, onShowDetails, onActivate, onChange, snippets = [], onRemoveSnippet, contextHint, color = "var(--primary)", followUpOf }, ref) {
  const { q, choices } = lq;
  const answered = isAnswered(value);
  const kind = KINDS.find((k) => k.value === q.kind)!;
  const list = Array.isArray(value) ? value : [];

  const option = (c: LabelQuestion["choices"][number], i: number, on: boolean, onClick: () => void, extra?: React.ReactNode) => (
    <button
      key={c.value}
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
        onClick();
      }}
      className={cn(
        "group/opt flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-[background-color,box-shadow,color] duration-150",
        on ? "bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "bg-background hover:bg-sel",
      )}
    >
      <Key k={active ? choiceKey(i) : null} on={on} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium leading-5">{c.label}</span>
        {c.description && (
          <Clamp toggleable={false} className={cn("text-[11.5px] leading-snug", on ? "text-primary-foreground/80" : "text-muted-foreground")}>
            {c.description}
          </Clamp>
        )}
      </span>
      {extra}
    </button>
  );

  return (
    <div
      ref={ref}
      onClick={onActivate}
      className={cn(
        "@container flex flex-col rounded-[14px] p-3 transition-[background-color,box-shadow] duration-200",
        active ? "bg-card shadow-[0_0_0_2px_var(--q)]" : "cursor-pointer bg-card/60 hover:bg-card",
      )}
      style={{ "--q": color } as React.CSSProperties}
    >
      <div className="mb-2.5 flex items-start gap-2">
        <span
          className="mt-px grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold tnum transition-colors"
          style={answered || active ? { background: color, color: "white" } : { background: tint(color, 16), color }}
        >
          {answered ? <Check className="size-3" strokeWidth={3} /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold leading-snug">{lq.title}</div>
          <div className="text-[11.5px] text-faint">
            {followUpOf && <span title="Shown because of this earlier answer">Follow-up of {followUpOf} · </span>}
            {kind.label}
            {q.kind === "multi" && active && " · keys toggle, ↵ when done"}
            {q.kind === "rank" && active && " · pick in order of fit"}
          </div>
        </div>
        {answered && (
          <button
            title="Clear answer (⌫)"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            className="grid size-6 shrink-0 place-items-center rounded-full text-faint hover:bg-sel hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {q.context.trim() && (
        <Clamp expanded={false} onExpandedChange={onShowDetails} hint={active ? "C" : undefined} className="mb-2.5 rounded-[8px] bg-background px-2.5 py-1.5 text-[11.5px] leading-snug text-muted-foreground">
          {q.context}
        </Clamp>
      )}

      {/* Pushes the answers to the bottom, so cards side by side line up. */}
      <div className="min-h-0 flex-1" />

      {q.kind === "noul" && (
        <div className="grid grid-cols-2 gap-1.5">
          {choices.map((c) => {
            const on = value === (c.value === "yes");
            return option(c, c.value === "yes" ? 0 : 1, on, () => onChange(on ? null : c.value === "yes"));
          })}
        </div>
      )}

      {q.kind === "score" && (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(choices.length, 5)}, minmax(0, 1fr))` }}>
          {choices.map((c, i) => {
            const on = value === c.value;
            return (
              <button
                key={c.value}
                onClick={(e) => {
                  e.stopPropagation();
                  onActivate();
                  onChange(on ? null : c.value);
                }}
                className={cn("flex flex-col items-center gap-1 rounded-[10px] px-1.5 py-2 text-center transition-colors", on ? "bg-primary text-primary-foreground" : "bg-background hover:bg-sel")}
              >
                <Key k={active ? choiceKey(i) : null} on={on} />
                <span className="line-clamp-2 text-[12px] font-medium leading-tight">{c.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {q.kind === "choice" && <div className={optionGrid(choices.length)}>{choices.map((c, i) => option(c, i, value === c.value, () => onChange(value === c.value ? null : c.value)))}</div>}

      {q.kind === "multi" && (
        <div className={optionGrid(choices.length)}>
          {choices.map((c, i) => {
            const on = list.includes(c.value);
            return option(c, i, on, () => onChange(on ? list.filter((x) => x !== c.value) : [...list, c.value]), <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border", on ? "border-primary-foreground/60" : "border-border-strong")}>{on && <Check className="size-3" strokeWidth={3} />}</span>);
          })}
        </div>
      )}

      {q.kind === "rank" && (
        <div className={optionGrid(choices.length)}>
          {choices.map((c, i) => {
            const rank = list.indexOf(c.value);
            const on = rank >= 0;
            return option(c, i, on, () => onChange(on ? list.filter((x) => x !== c.value) : [...list, c.value]), on ? <span className="font-mono text-[12px] font-semibold tnum">#{rank + 1}</span> : null);
          })}
          {list.length > 0 && list.length < choices.length && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChange([...list, ...choices.map((c) => c.value).filter((v) => !list.includes(v))]);
              }}
              className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3" /> Rank the rest in this order
            </button>
          )}
        </div>
      )}

      {q.kind === "text" && <FreeTextAnswer key={lq.id} value={typeof value === "string" ? value : ""} active={active} onActivate={onActivate} onChange={onChange} />}

      {q.kind === "number" && (
        <div className="space-y-2">
          <input
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            onFocus={onActivate}
            placeholder={q.unit ? `Value in ${q.unit}` : "Value"}
            className="h-9 w-full rounded-[10px] border border-border bg-background px-3 font-mono text-[14px] outline-none focus:border-primary focus:ring-[3px] focus:ring-ring"
          />
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {choices.map((c, i) => {
                const on = value === Number(c.value);
                return (
                  <button
                    key={c.value}
                    onClick={(e) => {
                      e.stopPropagation();
                      onActivate();
                      onChange(on ? null : Number(c.value));
                    }}
                    className={cn("inline-flex h-7 items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[12px] font-medium", on ? "bg-primary text-primary-foreground" : "bg-background hover:bg-sel")}
                  >
                    <Key k={active ? choiceKey(i) : null} on={on} />
                    {c.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {snippets.length > 0 && (
        <div className="mt-2.5 space-y-1 border-t border-border pt-2">
          {snippets.map((x, k) => (
            <div key={k} className="group/sn flex items-start gap-1.5 rounded-r-[6px] border-l-2 py-0.5 pr-1 pl-1.5 text-[11.5px] leading-snug text-muted-foreground" style={{ borderColor: color, background: tint(color, 7) }}>
              <Quote className="mt-0.5 size-3 shrink-0" style={{ color }} />
              <span className="line-clamp-2 min-w-0 flex-1" title={x.text}>
                {x.text}
              </span>
              {onRemoveSnippet && (
                <button
                  title="Remove this context"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSnippet(k);
                  }}
                  className="shrink-0 rounded-[4px] p-0.5 text-faint opacity-0 transition-opacity group-hover/sn:opacity-100 hover:text-foreground focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {active && contextHint && snippets.length === 0 && <div className="mt-2 text-[11px] text-faint">Select text in the entry to add it as context for this answer.</div>}
    </div>
  );
});

/** A written answer, saved shortly after typing stops (and when leaving the field). */
function FreeTextAnswer({ value, active, onActivate, onChange }: { value: string; active: boolean; onActivate: () => void; onChange: (v: LabelValue | null) => void }) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  const saved = useRef(value);
  // Follow outside changes (another entry, a cleared answer) only while not typing.
  useEffect(() => {
    if (focused) return;
    setV(value);
    saved.current = value;
  }, [value, focused]);
  const commit = (next: string) => {
    if (next === saved.current) return;
    saved.current = next;
    onChange(next.trim() ? next : null);
  };
  useEffect(() => {
    const t = setTimeout(() => commit(v), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <div>
      <textarea
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => {
          setFocused(true);
          onActivate();
        }}
        onBlur={() => {
          setFocused(false);
          commit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        rows={Math.min(8, Math.max(3, v.split("\n").length + 1))}
        placeholder="Write your answer…"
        className="w-full resize-none rounded-[10px] border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-faint focus:border-primary focus:ring-[3px] focus:ring-ring"
      />
      {active && !focused && <div className="mt-1 text-[11px] text-faint">↵ to write · Esc to leave the field</div>}
    </div>
  );
}
