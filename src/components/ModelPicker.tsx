import clsx from "clsx";
import { Check, Download, Plus } from "lucide-react";
import { useApp } from "../lib/app";
import { shortModel } from "../lib/format";

/** Multi-select chips over the installed models. */
export function ModelPicker({ value, onChange, colors }: { value: string[]; onChange: (v: string[]) => void; colors?: (i: number) => string }) {
  const { models, go } = useApp();
  if (models.length === 0) {
    return (
      <button onClick={() => go({ page: "models" })} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[12.5px] text-muted hover:border-accent hover:text-accent">
        <Download className="size-3.5" /> No models installed yet — open the model library
      </button>
    );
  }
  const toggle = (m: string) => onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((m) => {
        const i = value.indexOf(m.name);
        const on = i >= 0;
        return (
          <button
            key={m.name}
            onClick={() => toggle(m.name)}
            className={clsx(
              "flex h-7.5 items-center gap-1.5 rounded-lg border pl-2 pr-2.5 text-[12.5px] font-medium transition-all",
              on ? "border-transparent bg-fg text-bg" : "border-line-strong bg-panel text-muted hover:border-fg/30 hover:text-fg",
            )}
          >
            {on ? (
              <span className="grid size-3.5 place-items-center rounded-full" style={{ background: colors ? colors(i) : "var(--accent)" }}>
                <Check className="size-2.5 text-white" strokeWidth={3} />
              </span>
            ) : (
              <Plus className="size-3.5" />
            )}
            {shortModel(m.name)}
            {m.details.parameter_size && <span className={clsx("font-mono text-[10.5px]", on ? "opacity-60" : "text-faint")}>{m.details.parameter_size}</span>}
          </button>
        );
      })}
    </div>
  );
}
