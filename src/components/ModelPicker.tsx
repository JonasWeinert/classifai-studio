import { cn } from "@/lib/utils";
import { Check, Cloud, Download, Plus } from "lucide-react";
import { useApp } from "../lib/app";
import { price, shortModel } from "../lib/format";

/** Multi-select chips over installed local models and configured cloud models. */
export function ModelPicker({ value, onChange, colors }: { value: string[]; onChange: (v: string[]) => void; colors?: (i: number) => string }) {
  const { models, cloudModels, go } = useApp();
  if (models.length === 0 && cloudModels.length === 0) {
    return (
      <button onClick={() => go({ page: "models" })} className="flex w-full items-center gap-2 rounded-[10px] border border-dashed border-border-strong px-3 py-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">
        <Download className="size-3.5" /> No models yet — download a local model or connect a cloud provider
      </button>
    );
  }
  const toggle = (m: string) => onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m]);
  const chip = (id: string, label: string, meta: string | null, cloud: boolean) => {
    const i = value.indexOf(id);
    const on = i >= 0;
    return (
      <button
        key={id}
        onClick={() => toggle(id)}
        title={cloud ? `${id} · ${meta}` : id}
        className={cn(
          "flex h-[26px] items-center gap-1.5 rounded-full pl-1.5 pr-2.5 text-[12.5px] font-medium transition-colors duration-150",
          on ? "bg-primary/10 text-foreground shadow-[0_0_0_1px_var(--primary)_inset]" : "bg-sel text-muted-foreground hover:text-foreground",
        )}
      >
        {on ? (
          <span className="grid size-4 place-items-center rounded-full" style={{ background: colors ? colors(i) : "var(--primary)" }}>
            <Check className="size-2.5 text-white" strokeWidth={3} />
          </span>
        ) : (
          <Plus className="size-3.5" />
        )}
        {cloud && <Cloud className="size-3 text-faint" />}
        {label}
        {meta && <span className="font-mono text-[10.5px] text-faint">{meta}</span>}
      </button>
    );
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((m) => chip(m.name, shortModel(m.name), m.details.parameter_size || null, false))}
      {cloudModels.map((m) => chip(m.id, m.display_name, price(m.input_price_per_mtok), true))}
    </div>
  );
}
