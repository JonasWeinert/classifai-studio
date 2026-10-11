// Follow-up editing, shared by the question editors and New Evaluation: a slim "Follow-up if
// [Yes] [No]" row under a question (one click adds a branch for that answer) and an "If #2 is
// [No]" tag on a follow-up.
import { cn } from "@/lib/utils";
import { CornerDownRight, Info, Plus, X } from "lucide-react";

/** Yes/no answers are stored lower-case; show them capitalised. */
export const answerLabel = (a: string) => (a === "yes" ? "Yes" : a === "no" ? "No" : a);

/** How many answers get their own pill before the rest go into a menu. */
const PILLS = 6;

const HOW = "A follow-up is asked only when its earlier question gets one of the chosen answers. Models answer it in a later pass, with the earlier question and its answer added to the input; in manual labelling it appears once that answer is given.";

/** Under a question: one pill per answer; a click adds a follow-up for that answer. */
export function BranchRow({ choices, counts, onAdd }: { choices: string[]; counts: Record<string, number>; onAdd: (answer: string) => void }) {
  if (!choices.length) return null;
  const shown = choices.slice(0, PILLS);
  const rest = choices.slice(PILLS);
  // Faint until the question is hovered, unless it already has follow-ups.
  const quiet = !Object.values(counts).some(Boolean);
  return (
    <div className={cn("flex flex-wrap items-center gap-1 text-[12px] transition-opacity", quiet && "opacity-40 group-hover/q:opacity-100 focus-within:opacity-100")}>
      <span className="mr-0.5 inline-flex items-center gap-1 text-muted-foreground" title={HOW}>
        <CornerDownRight className="size-3.5 text-faint" />
        Follow-up if
      </span>
      {shown.map((c) => (
        <button
          key={c}
          onClick={() => onAdd(c)}
          title={`Add a question asked only when the answer is “${answerLabel(c)}”`}
          className="group/br inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-dashed border-border-strong px-2 py-px text-[11.5px] text-muted-foreground transition-colors hover:border-solid hover:border-primary hover:text-foreground"
        >
          <Plus className="size-3 shrink-0 opacity-50 group-hover/br:opacity-100" />
          <span className="truncate">{answerLabel(c)}</span>
          {!!counts[c.toLowerCase()] && <span className="tnum text-faint">· {counts[c.toLowerCase()]}</span>}
        </button>
      ))}
      {rest.length > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && onAdd(e.target.value)}
          className="rounded-full border border-dashed border-border-strong bg-transparent px-2 py-px text-[11.5px] text-muted-foreground outline-none hover:text-foreground"
        >
          <option value="">+{rest.length} more…</option>
          {rest.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Above a follow-up: "↳ If #2 is [Yes] [No]" — chips toggle which answers trigger it; × makes it a regular question. */
export function BranchTag({ parentIndex, parentTitle, choices, picked, onToggle, onUnlink }: { parentIndex: number; parentTitle: string; choices: string[]; picked: (c: string) => boolean; onToggle: (c: string) => void; onUnlink: () => void }) {
  const none = !choices.some(picked);
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[12px]">
      <span className="inline-flex items-center gap-1 text-muted-foreground" title={parentTitle}>
        <CornerDownRight className="size-3.5 text-primary" />
        If <b className="font-semibold text-foreground">#{parentIndex + 1}</b> is
      </span>
      {/* Many answers: only the chosen ones as chips, the rest in a menu. */}
      {(choices.length > PILLS + 2 ? choices.filter(picked) : choices).map((c) => (
        <button
          key={c}
          onClick={() => onToggle(c)}
          className={cn("max-w-[10rem] truncate rounded-full px-2 py-px text-[11.5px] font-medium transition-colors", picked(c) ? "bg-primary text-primary-foreground" : "text-faint hover:bg-sel hover:text-foreground")}
        >
          {answerLabel(c)}
        </button>
      ))}
      {choices.length > PILLS + 2 && (
        <select value="" onChange={(e) => e.target.value && onToggle(e.target.value)} className="rounded-full bg-transparent px-1.5 py-px text-[11.5px] text-faint outline-none hover:bg-sel hover:text-foreground">
          <option value="">+ answer…</option>
          {choices
            .filter((c) => !picked(c))
            .map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
        </select>
      )}
      {none && <span className="text-[11.5px] text-warn">pick an answer</span>}
      <span title={HOW} className="ml-0.5 text-faint">
        <Info className="size-3" />
      </span>
      <button onClick={onUnlink} title="Not a follow-up: ask always" className="rounded-[4px] p-0.5 text-faint hover:bg-sel hover:text-foreground">
        <X className="size-3" />
      </button>
    </div>
  );
}
