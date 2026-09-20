"use client";

import { useActionState, useState, useTransition } from "react";
import { addHoliday, deleteHoliday, type HolidayResult } from "./actions";

export type Holiday = { id: string; date: string; name: string };

const initialState: HolidayResult = { ok: false, error: "" };

const inputClass =
  "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

function formatDate(date: string) {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function OrgHolidayRow({ holiday }: { holiday: Holiday }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteHoliday(holiday.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <p className="text-sm font-medium">{holiday.name}</p>
          <p className="text-xs text-text-secondary">{formatDate(holiday.date)}</p>
        </div>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-2"
          >
            Remove
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface-2 p-3">
          <p className="text-sm">
            Remove <span className="font-semibold">{holiday.name}</span> ({formatDate(holiday.date)})? Days staff have
            already saved as PH stay as they are.
          </p>
          {error && <p className="text-sm text-returning">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-60"
            >
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={pending}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function HolidaysManager({ orgHolidays, nationalHolidays }: { orgHolidays: Holiday[]; nationalHolidays: Holiday[] }) {
  const [state, formAction, pending] = useActionState(addHoliday, initialState);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4" />
          </svg>
        </span>
        <div>
          <h1 className="text-xl font-semibold">Public holidays</h1>
          <p className="text-sm text-text-secondary">
            Add days the organisation observes. On a holiday a staff member hasn&apos;t filled in, PH is suggested.
          </p>
        </div>
      </div>

      <form
        action={formAction}
        className="flex max-w-md flex-col gap-4 rounded-xl border border-border bg-surface p-6"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="holidayDate" className="text-sm font-medium">
            Date
          </label>
          <input id="holidayDate" name="date" type="date" required min="2020-01-01" max="2100-12-31" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="holidayName" className="text-sm font-medium">
            Name
          </label>
          <input id="holidayName" name="name" type="text" required maxLength={100} placeholder="e.g. Eid al-Fitr" className={inputClass} />
        </div>
        {state.ok && (
          <p role="status" className="text-sm text-approved">
            Holiday added.
          </p>
        )}
        {!state.ok && state.error && (
          <p role="alert" className="text-sm text-returning">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add holiday"}
        </button>
      </form>

      <section className="flex flex-col gap-3" aria-labelledby="org-holidays-heading">
        <h2 id="org-holidays-heading" className="text-lg font-semibold">
          Added by your organisation
        </h2>
        {orgHolidays.length === 0 ? (
          <p className="text-sm text-text-secondary">None yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {orgHolidays.map((h) => (
              <OrgHolidayRow key={h.id} holiday={h} />
            ))}
          </ul>
        )}
      </section>

      <details className="rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
          National holidays (built in, can&apos;t be changed here) — {nationalHolidays.length}
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {nationalHolidays.map((h) => (
            <li key={h.id} className="px-4 py-2.5">
              <p className="text-sm font-medium">{h.name}</p>
              <p className="text-xs text-text-secondary">{formatDate(h.date)}</p>
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-4 py-3 text-xs text-text-secondary">
          Eid al-Fitr, Eid al-Kabir and Eid al-Mawlid move with the moon and are announced shortly beforehand — add
          them above once officially announced.
        </p>
      </details>
    </div>
  );
}
