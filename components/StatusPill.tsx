// The one place a timesheet's own status is shown as a prominent element.
//
// History: this was "fixed" twice by retuning neutral surface/border tokens
// and still read as near-invisible. Measured against real computed styles,
// the actual causes were (1) on the approver/HR detail screens, a stray
// `text-base` class — Tailwind treats `text-base` as BOTH the font-size and
// `color: var(--color-base)`, the page background token — so the label
// rendered page-colored on a page-colored pill (1.09:1 light, 1.19:1 dark),
// and (2) on the staff screen, a fill and border only 1.09-1.8:1 away from
// the page, so the shape itself vanished even though the text was fine.
// Both are fixed at the root (the `base` color token was renamed so the
// collision can't recur) and this shared component replaces four separate
// hand-rolled copies.
//
// Deliberately blue-bordered, not status-colored: blue is the identity
// color in this app and the pending/returning/approved chip hues stay
// reserved for scanning lists (see CLAUDE.md "Design direction").
export function StatusPill({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border-2 border-accent bg-surface px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-on-tint">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </span>
      <p className="text-lg font-semibold leading-snug text-text-primary">{label}</p>
    </div>
  );
}
