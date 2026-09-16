import {
  type AttendanceStatus,
  STATUS_OPTIONS,
  WEEKDAY_LABELS,
  daysInMonth,
  dateKey,
  leadingBlanksForMonth,
} from "@/lib/timesheet";

const STATUS_CODE = Object.fromEntries(
  STATUS_OPTIONS.map((opt) => [opt.value, opt.code]),
) as Record<AttendanceStatus, string>;

export function AttendanceGrid({
  year,
  month,
  entries,
  editable,
  onChange,
}: {
  year: number;
  month: number;
  entries: Record<string, AttendanceStatus>;
  editable: boolean;
  onChange?: (day: number, status: AttendanceStatus) => void;
}) {
  const totalDays = daysInMonth(year, month);
  const leadingBlanks = leadingBlanksForMonth(year, month);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 grid grid-cols-7 gap-2 text-center text-xs font-medium text-text-muted">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: leadingBlanks }).map((_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {Array.from({ length: totalDays }, (_, i) => i + 1).map((day) => {
          const key = dateKey(year, month, day);
          const status = entries[key];
          return (
            <div key={day} className="flex flex-col items-center gap-1 rounded-lg bg-surface-2 p-1.5">
              <span className="text-xs font-medium text-text-secondary">{day}</span>
              <span className="text-sm font-bold leading-none text-text-primary" aria-hidden="true">
                {status ? STATUS_CODE[status] : "–"}
              </span>
              <select
                id={`day-${key}`}
                disabled={!editable}
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
      <p className="mt-3 text-xs text-text-muted">
        P = Present · A = Absent · PH = Public holiday · L = Leave
      </p>
    </div>
  );
}
