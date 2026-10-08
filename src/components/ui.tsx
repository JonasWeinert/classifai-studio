import clsx from "clsx";
import { Loader2, X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-all select-none",
        "disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        size === "sm" && "h-7 px-2.5 text-[12.5px]",
        size === "md" && "h-8.5 px-3.5 text-[13px]",
        size === "lg" && "h-10.5 px-5 text-[14px]",
        variant === "primary" && "bg-accent text-accent-fg shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_1px_2px_rgba(0,0,0,.2)] hover:brightness-110 active:brightness-95",
        variant === "secondary" && "bg-panel border border-line-strong text-fg hover:bg-panel-2 shadow-[0_1px_2px_rgba(0,0,0,.04)]",
        variant === "ghost" && "text-muted hover:text-fg hover:bg-panel-2",
        variant === "danger" && "text-bad hover:bg-bad-soft",
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={clsx("rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(0,0,0,.03)]", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold tracking-[-0.01em]">{title}</div>
        {subtitle && <div className="mt-0.5 text-[12.5px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "good" | "bad" | "warn"; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-panel-2 text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
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

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        "h-8.5 w-full rounded-lg border border-line-strong bg-panel px-3 text-[13px] outline-none placeholder:text-faint",
        "focus:border-accent focus:ring-3 focus:ring-accent/15 transition-shadow",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={clsx(
        "w-full resize-none rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-faint",
        "focus:border-accent focus:ring-3 focus:ring-accent/15 transition-shadow",
        className,
      )}
    />
  );
}

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        "h-8.5 rounded-lg border border-line-strong bg-panel px-2.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/15",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-[12px] font-medium text-muted">{children}</span>
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-lg bg-panel-2 p-0.5 border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-md px-2.5 font-medium transition-all",
            size === "sm" ? "h-6 text-[12px]" : "h-7 text-[12.5px]",
            value === o.value ? "bg-panel text-fg shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, className, color, indeterminate }: { value: number; className?: string; color?: string; indeterminate?: boolean }) {
  return (
    <div className={clsx("h-1.5 overflow-hidden rounded-full bg-panel-2", className)}>
      {indeterminate ? (
        <div className="h-full w-full shimmer" />
      ) : (
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color ?? "var(--accent)" }} />
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center fade-up">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="mt-1.5 max-w-sm text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("size-4 animate-spin text-muted", className)} />;
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-[2px] fade-up" onMouseDown={onClose}>
      <div className="max-h-[85vh] overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl flex flex-col" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-[14px] font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div>
      <div className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-faint">{label}</div>
      <div className={clsx("mt-1 text-[22px] font-semibold tracking-[-0.02em] tnum", tone === "good" && "text-good", tone === "bad" && "text-bad")}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        {back && <div className="mb-2">{back}</div>}
        <h1 className="text-[22px] font-semibold tracking-[-0.025em]">{title}</h1>
        {subtitle && <div className="mt-1 text-[13.5px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-[12.5px] text-bad" data-selectable>{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-panel-2 px-1 py-px font-mono text-[10.5px] text-muted">{children}</kbd>;
}
