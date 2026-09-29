import {
  type AttendanceStatus,
  STATUS_OPTIONS,
  WEEKDAY_LABELS,
  daysInMonth,
  dateKey,
  isAfterToday,
  leadingBlanksForMonth,
} from "@/lib/timesheet";

const STATUS_CODE = Object.fromEntries(
  STATUS_OPTIONS.map((opt) => [opt.value, opt.code]),
) as Record<AttendanceStatus, string>;

// WEEKDAY_LABELS is Mon..Sun (0-indexed), so Sat/Sun are columns 5 and 6 —
// see leadingBlanksForMonth in lib/timesheet.ts for why the grid is Mon-first.
const WEEKEND_COLUMNS = new Set([5, 6]);

// Filled/weekend are two independent "lean into the accent" asks (CLAUDE.md
// design direction, 2026-09-18) that both want a background wash on the same
// cells. Rather than layer two separately-meaningful blue overlays (which
// would read as two competing signals), both collapse into one intensity
// scale — weekend nudges a cell's tint up a step rather than adding a second
// color. These are precomputed per-theme tokens (see globals.css), not a
// live bg-accent/N opacity utility — the same opacity against --accent reads
// clearly in light mode but is nearly invisible against --surface-2 in dark
// mode (accent is much lighter there), confirmed by compositing the actual
// values, not assumed. Contrast verified for every tier against both
// text-primary and text-secondary, light and dark (worst case 4.6:1, still
// clears AA 4.5:1).
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthShort = (month: number) => MONTH_SHORT[month - 1];

function cellBackground(filled: boolean, isWeekend: boolean) {
  if (filled) return isWeekend ? "bg-cell-filled-weekend" : "bg-cell-filled";
  return isWeekend ? "bg-cell-weekend" : "bg-surface-2";
}

export function AttendanceGrid({
  year,
  month,
  entries,
  editable,
  onChange,
  holidays,
  today,
}: {
  year: number;
  month: number;
  entries: Record<string, AttendanceStatus>;
  editable: boolean;
  onChange?: (day: number, status: AttendanceStatus) => void;
  // date key -> holiday name(s). Optional: the approver views don't pass it.
  holidays?: Record<string, string>;
  // Today's date key (YYYY-MM-DD) as the database sees it. When given, days
  // after it are not offered for entry — the database rejects them too, this
  // just says so up front. Omit for read-only views (approvers): nothing there
  // is editable anyway.
  today?: string;
}) {
  const holidayDates = Object.keys(holidays ?? {}).sort();
  const totalDays = daysInMonth(year, month);
  const leadingBlanks = leadingBlanksForMonth(year, month);
  const filledDays = Object.keys(entries).length;
  const hasFutureDays = today !== undefined && isAfterToday(dateKey(year, month, totalDays), today);
  const progressPct = totalDays > 0 ? Math.round((filledDays / totalDays) * 100) : 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="grid grid-cols-7 gap-2 bg-accent/12 px-4 py-2 text-center text-xs font-semibold text-accent-on-tint">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="p-4">
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: leadingBlanks }).map((_, i) => (
            <div key={`blank-${i}`} className={`rounded-lg ${WEEKEND_COLUMNS.has(i % 7) ? "bg-cell-weekend" : ""}`} />
          ))}
          {Array.from({ length: totalDays }, (_, i) => i + 1).map((day) => {
            const key = dateKey(year, month, day);
            const status = entries[key];
            const column = (leadingBlanks + day - 1) % 7;
            const isWeekend = WEEKEND_COLUMNS.has(column);
            const holidayName = holidays?.[key];
            const notYet = today !== undefined && isAfterToday(key, today);
            const tooltip = notYet
              ? "Not available yet — you can fill this day in once it arrives"
              : holidayName
                ? `Public holiday: ${holidayName}`
                : undefined;
            return (
              <div
                key={day}
                title={tooltip}
                className={`flex flex-col items-center gap-1 rounded-lg p-1.5 transition-colors ${cellBackground(!!status, isWeekend)} ${notYet ? "opacity-55" : ""}`}
              >
                <span className="flex items-center gap-1 text-xs font-medium text-text-secondary">
                  {day}
                  {holidayName && (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" role="img" aria-label={`Public holiday: ${holidayName}`} />
                  )}
                </span>
                <span className="text-sm font-bold leading-none text-text-primary" aria-hidden="true">
                  {status ? STATUS_CODE[status] : "–"}
                </span>
                <select
                  id={`day-${key}`}
                  disabled={!editable || notYet}
                  aria-label={`${day} — ${notYet ? "not available yet" : "attendance"}`}
                  value={status ?? ""}
                  onChange={(e) => onChange?.(day, e.target.value as AttendanceStatus)}
                  className="w-full rounded-md border border-border bg-surface px-1 py-1 text-center text-xs font-semibold text-text-primary outline-none focus:border-accent disabled:opacity-70"
                >
                  <option value="" disabled>
                    –
                  </option>
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.code}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        {editable && (
          <div className="mt-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="whitespace-nowrap text-xs font-medium text-text-secondary">
              {filledDays} of {totalDays} days filled
            </span>
          </div>
        )}

        {holidayDates.length > 0 && (
          <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
            <p className="flex items-center gap-1.5 font-semibold text-text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              Public holidays this month
            </p>
            <ul className="mt-1">
              {holidayDates.map((key) => (
                <li key={key}>
                  {Number(key.slice(8))} {monthShort(month)} — {holidays![key]}
                </li>
              ))}
            </ul>
            {editable && (
              <p className="mt-1">
                A holiday you haven&apos;t filled in starts as PH once the day has arrived — change it if you worked.
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-text-muted">
          P = Present · A = Absent · PH = Public holiday · L = Leave
        </p>
        {editable && hasFutureDays && (
          <p className="mt-1 text-xs text-text-muted">Faded days haven&apos;t arrived yet — they open up one day at a time.</p>
        )}
      </div>
    </div>
  );
}
