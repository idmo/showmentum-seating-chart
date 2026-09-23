// Small Tailwind-based UI primitives shared across pages — mirrors the
// original single-file artifact's .btn / .panel / .stat-tile / .badge
// classes, just as React components instead of global CSS classes.
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const sizes = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  const variants = {
    default: "border-line bg-paper-raised text-ink hover:border-line-strong",
    primary: "border-accent bg-accent text-accent-ink hover:opacity-90",
    danger: "border-state-danger/30 bg-state-danger-soft text-state-danger hover:border-state-danger/60",
    ghost: "border-transparent bg-transparent text-ink-soft hover:bg-paper-raised hover:text-ink",
  } as const;
  return <button className={cx(base, sizes, variants[variant], className)} {...props} />;
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("rounded-xl border border-line bg-paper-raised p-4 shadow-sm", className)}
      {...props}
    />
  );
}

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "ok" | "warn" | "danger" | "accent" }) {
  const tones = {
    neutral: "bg-paper text-ink-soft border-line",
    ok: "bg-state-ok-soft text-state-ok border-state-ok/30",
    warn: "bg-state-warn-soft text-state-warn border-state-warn/30",
    danger: "bg-state-danger-soft text-state-danger border-state-danger/30",
    accent: "bg-accent-soft text-accent-soft-ink border-accent-soft-line",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("mb-1 block text-xs font-medium text-ink-soft", className)} {...props} />;
}

export function StatTile({ label, value, tone = "neutral" }: { label: string; value: React.ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <div
      className={cx(
        "rounded-lg border px-3 py-2",
        tone === "accent" ? "border-accent-soft-line bg-accent-soft" : "border-line bg-paper",
      )}
    >
      <div className={cx("text-lg font-semibold font-mono-num", tone === "accent" ? "text-accent-soft-ink" : "text-ink")}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-ink-soft">{label}</div>
    </div>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      {subtitle && <p className="mt-1 text-xs text-ink-faint">{subtitle}</p>}
    </div>
  );
}
