// App-level UI primitives. Interactive controls are beUI components (src/components/motion,
// https://beui.dev) wrapped with ClassifAI's defaults; layout helpers follow macOS forms:
// right-aligned labels and controls placed directly on the window background.
import { cn } from "@/lib/utils";
import { Button as BeButton } from "@/components/motion/button";
import { Checkbox as BeCheckbox } from "@/components/motion/checkbox";
import { CenterMorphModal, CenterMorphModalContent } from "@/components/motion/center-morph-modal";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/motion/collapsible";
import { Input as BeInput } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { RangeSlider } from "@/components/motion/range-slider";
import { Select as BeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select";
import { Switch as BeSwitch } from "@/components/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useToolbar } from "@/lib/toolbar";
import { useApp } from "@/lib/app";
import { describeError } from "@/lib/errors";
import { Tooltip } from "@/components/motion/tooltip";

export { Tooltip };

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  onClick,
  title,
  type,
}: {
  variant?: Variant;
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <BeButton
      type={type ?? "button"}
      title={title}
      variant={variant === "danger" ? "ghost" : variant}
      size={size}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        variant === "secondary" && "border-border-strong/70 bg-background shadow-[0_0.5px_1px_rgba(0,0,0,.08)] hover:bg-card dark:bg-white/8",
        variant === "danger" && "text-bad hover:bg-bad-soft hover:text-bad",
        variant === "ghost" && "hover:bg-sel",
        className,
      )}
    >
      {loading ? <Loader variant="spinner" size={13} /> : icon}
      {children}
    </BeButton>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  className,
  type,
  min,
  disabled,
  autoFocus,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
  min?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <BeInput
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      min={min}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className}
      classNames={{ input: mono ? "font-mono text-[12px]" : undefined }}
    />
  );
}

/** Multi-line field styled to match beUI's Input. */
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cn(
        "w-full resize-none rounded-[10px] border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed text-foreground caret-primary outline-none placeholder:text-muted-foreground/60",
        "transition-[border-color,box-shadow] duration-200 focus:border-primary focus:ring-[3px] focus:ring-ring",
        className,
      )}
    />
  );
}

export function Select({ value, onChange, options, className, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; placeholder?: string }) {
  return (
    <BeSelect value={value} onValueChange={onChange} className={cn("min-w-[9rem]", className)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent className="max-h-72 overflow-auto p-1">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </BeSelect>
  );
}

/** Segmented control (beUI Tabs, segment variant). */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: "sm" | "md" }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)} variant="segment">
      <TabsList>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value}>
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string; size?: "sm" | "md" }) {
  return <BeSwitch checked={checked} onCheckedChange={onChange} label={label} ariaLabel={label} />;
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <BeCheckbox checked={checked} onCheckedChange={onChange} label={label} disabled={disabled} />;
}

export function Slider({ value, onChange, min, max, step, className }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; className?: string }) {
  return <RangeSlider value={value} onValueChange={onChange} min={min} max={max} step={step} showTicks={false} className={className} />;
}

/** A disclosure: "▸ label" that reveals content with beUI's collapsible motion. */
export function Disclosure({ label, children, defaultOpen, className }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={className}>
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-[5px] text-[12px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform duration-200 group-aria-expanded:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A subtle filled surface, for results that need grouping. Prefer placing content on the background. */
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("rounded-[14px] bg-card", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 pt-3 pb-2.5", className)}>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">{title}</div>
        {subtitle && <div className="mt-px text-[12px] text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled region separated by a hairline — no box. */
export function Section({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-t border-border pt-5 pb-7 first:border-t-0 first:pt-0", className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-[14rem] flex-1">
            {title && <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>}
            {subtitle && <div className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One row of a macOS form: right-aligned label, control, optional hint beneath. */
export function FormRow({ label, hint, children, align = "center", labelWidth = 150 }: { label: ReactNode; hint?: ReactNode; children: ReactNode; align?: "center" | "start"; labelWidth?: number }) {
  return (
    <div className="grid gap-x-3 py-1.5" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      <div className={cn("text-right text-[13px] text-foreground", align === "start" ? "pt-[5px]" : "self-center")}>{label}</div>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-1 text-[11.5px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "good" | "bad" | "warn"; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-sel text-muted-foreground",
        tone === "accent" && "bg-primary/12 text-primary",
        tone === "good" && "bg-good-soft text-good",
        tone === "bad" && "bg-bad-soft text-bad",
        tone === "warn" && "bg-warn-soft text-warn",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-[12px] font-medium text-muted-foreground">{children}</span>
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </div>
  );
}

export function Progress({ value, className, color, indeterminate }: { value: number; className?: string; color?: string; indeterminate?: boolean }) {
  return (
    <div className={cn("h-[5px] overflow-hidden rounded-full bg-sel", className)}>
      {indeterminate ? (
        <div className="h-full w-full shimmer" />
      ) : (
        <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color ?? "var(--primary)" }} />
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center fade-up">
      <div className="mb-3 text-faint [&_svg]:size-9 [&_svg]:stroke-[1.25]">{icon}</div>
      <div className="text-[14px] font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-sm text-[12.5px] text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** beUI loader that only appears if loading takes longer than a moment (no flashes). */
export function Spinner({ className, delay = 200 }: { className?: string; delay?: number }) {
  const [show, setShow] = useState(delay === 0);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  if (!show) return null;
  return (
    <span className={cn("inline-flex text-faint", className)}>
      <Loader variant="spinner" size={14} />
    </span>
  );
}

/** beUI center-morph modal with a title and footer. */
export function Modal({ open, onClose, title, children, footer, width = 420 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <CenterMorphModal open={open} onOpenChange={(o) => !o && onClose()}>
      <CenterMorphModalContent ariaLabel={typeof title === "string" ? title : "Dialog"} className="rounded-[22px]" backdropClassName="bg-black/15">
        <div style={{ maxWidth: width }} className="px-6 pt-5 pb-5">
          <div className="pr-8 text-[15px] font-semibold">{title}</div>
          <div className="mt-2 text-[13px]">{children}</div>
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-faint">{label}</div>
      <div className={cn("mt-0.5 text-[20px] font-semibold tracking-[-0.02em] tnum", tone === "good" && "text-good", tone === "bad" && "text-bad")}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Page title, subtitle and actions, rendered into the window toolbar (falls back to inline). */
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { label: string; onClick: () => void } }) {
  const toolbar = useToolbar();
  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-3 fade-up">
      {back && (
        <Tooltip content={`Back to ${back.label}`} side="bottom">
          <button onClick={back.onClick} aria-label={`Back to ${back.label}`} className="-ml-2 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-sel hover:text-foreground">
            <ChevronLeft className="size-[18px]" />
          </button>
        </Tooltip>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em]">
          {title}
        </h1>
        {subtitle && (
          <div className="truncate text-[11.5px] leading-tight text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
  if (toolbar) return createPortal(content, toolbar);
  return <div className="mb-6">{content}</div>;
}

/** Inline error. Pass `error` (a backend error) to get plain language and a one-click fix. */
export function ErrorNote({ children, error }: { children?: ReactNode; error?: unknown }) {
  const { go } = useApp();
  const problem = error !== undefined ? describeError(error) : null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad fade-up" data-selectable>
      <span className="min-w-0 flex-1">{problem ? problem.message : children}</span>
      {problem?.action && (
        <Button size="sm" variant="secondary" className="shrink-0" onClick={() => go(problem.action!.route)}>
          {problem.action.label}
        </Button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[4px] bg-sel px-1 py-px font-sans text-[11px] text-muted-foreground">{children}</kbd>;
}
