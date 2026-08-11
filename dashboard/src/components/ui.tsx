import { useEffect, useRef, type ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/* ---------------------------------------------------------------- badge --- */

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

/** SPF/DKIM/DMARC verdict → tone. Anything that isn't a pass deserves attention. */
export function verdictTone(v: string | null | undefined): Tone {
  if (!v) return "neutral";
  if (v === "pass") return "ok";
  if (v === "fail") return "bad";
  return "warn";
}

/* ----------------------------------------------------------- empty/load --- */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={26} className="glyph" />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <table>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }, (_, cIdx) => (
              <td key={cIdx}>
                <div
                  className="skeleton"
                  style={{ width: `${[70, 45, 90, 30][cIdx % 4]}%`, animationDelay: `${r * 70}ms` }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------ slideover --- */

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close panel">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </aside>
    </>
  );
}

/* ---------------------------------------------------------------- misc ---- */

export function Card({
  title,
  action,
  children,
  tight,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="card">
      {title && (
        <header className="card-head">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      <div className={`card-body${tight ? " tight" : ""}`}>{children}</div>
    </section>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <button
      className="sm"
      onClick={async (e) => {
        await navigator.clipboard.writeText(value);
        const el = e.currentTarget;
        const original = el.textContent;
        el.textContent = "Copied";
        setTimeout(() => {
          el.textContent = original;
        }, 1400);
      }}
    >
      {label}
    </button>
  );
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * A timestamp for a table cell.
 *
 * `absoluteTime` renders "Aug 2, 2026, 06:46:28 PM", which is wider than any
 * sensible column and wrapped its meridiem onto a second line, making rows
 * uneven. Seconds and the current year are noise in a "created" column, so both
 * go; the full form stays for detail views where precision is the point.
 */
export function compactTime(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * A confirmation the page owns, rather than window.confirm.
 *
 * The native dialog cannot be styled, says the origin rather than the app, and
 * on some platforms is suppressible — which for a destructive action means the
 * click just silently succeeds. It also names the thing being destroyed, since
 * "Are you sure?" is not information.
 */
export function Confirm({
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="confirm-scrim" role="presentation" onMouseDown={onCancel}>
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="small muted">{body}</div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Page through a long table.
 *
 * Renders nothing for a single page: a pager under six rows is furniture that
 * says only that there is nothing to page through.
 */
export function Pager({
  page,
  pageCount,
  total,
  shown,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  shown: number;
  onPage: (n: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <span className="small muted">
        {shown} of {total}
      </span>
      <span className="grow" />
      <button className="sm" onClick={() => onPage(page - 1)} disabled={page === 0}>
        Previous
      </button>
      <span className="small muted">
        {page + 1} / {pageCount}
      </span>
      <button className="sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount - 1}>
        Next
      </button>
    </div>
  );
}
