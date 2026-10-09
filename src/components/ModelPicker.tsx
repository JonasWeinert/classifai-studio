import { cn } from "@/lib/utils";
import { Check, ChevronDown, Cloud, Download, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/app";
import { price, shortModel } from "../lib/format";

/** Multi-select chips over installed local models and configured cloud models. */
export function ModelPicker({ value, onChange, colors, single }: { value: string[]; onChange: (v: string[]) => void; colors?: (i: number) => string; single?: boolean }) {
  const { models, cloudModels, go } = useApp();
  if (models.length === 0 && cloudModels.length === 0) {
    return (
      <button onClick={() => go({ page: "models" })} className="flex w-full items-center gap-2 rounded-[10px] border border-dashed border-border-strong px-3 py-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">
        <Download className="size-3.5" /> No models yet — download a local model or connect a cloud provider
      </button>
    );
  }
  const toggle = (m: string) => (single ? onChange([m]) : onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m]));
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

/** Compact toolbar version of the picker: a pill showing the selection that opens the chips in a popover. */
export function ModelMenu({ value, onChange, colors, single }: { value: string[]; onChange: (v: string[]) => void; colors?: (i: number) => string; single?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const label = value.length === 0 ? "Choose models" : value.length <= 2 ? value.map(shortModel).join(", ") : `${shortModel(value[0])} +${value.length - 1}`;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn("flex h-[28px] max-w-[260px] items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors", open ? "bg-sel text-foreground" : "text-muted-foreground hover:bg-sel hover:text-foreground")}
      >
        <span className="flex -space-x-1">
          {value.slice(0, 4).map((m, i) => (
            <span key={m} className="size-2.5 rounded-full ring-2 ring-background" style={{ background: colors ? colors(i) : "var(--primary)" }} />
          ))}
        </span>
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 top-[34px] z-50 w-[380px] rounded-[14px] border border-border bg-popover p-3 shadow-[0_12px_40px_rgba(0,0,0,.16)] fade-up">
          <div className="mb-2 text-[11.5px] font-medium text-muted-foreground">{single ? "Model" : "Models to compare"}</div>
          <ModelPicker
            value={value}
            onChange={(v) => {
              onChange(v);
              if (single) setOpen(false);
            }}
            colors={colors}
            single={single}
          />
        </div>
      )}
    </div>
  );
}
