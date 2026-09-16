"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { type Department, DEPARTMENT_LABEL, monthLabel } from "@/lib/timesheet";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type Candidate = {
  id: string;
  department: Department;
  month: number;
  year: number;
  profiles: { full_name: string } | null;
};

type ReturnedItem = {
  timesheetId: string;
  department: Department;
  month: number;
  year: number;
  staffName: string;
};

export function ReturnedItemsList({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ReturnedItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // RLS on timesheets already scopes this to only the returning
      // timesheets this approver can legitimately see (their assigned
      // staff, their department, or historical actor). Precisely which of
      // those are genuinely THEIR turn to acknowledge right now still has
      // to be asked of current_return_recipient per candidate — that
      // ordering can't be reconstructed client-side (see lib/timesheet.ts).
      const { data: candidates, error: candidatesError } = await supabase
        .from("timesheets")
        .select("id, department, month, year, profiles(full_name)")
        .eq("status", "returning");
      if (cancelled) return;
      if (candidatesError) {
        setError("Couldn't load returned items.");
        setLoading(false);
        return;
      }

      const rows = (candidates ?? []) as unknown as Candidate[];
      const checked = await Promise.all(
        rows.map(async (row) => {
          const { data: recipientId } = await supabase.rpc("current_return_recipient", {
            p_timesheet_id: row.id,
          });
          return { row, isMine: recipientId === userId };
        }),
      );
      if (cancelled) return;

      setItems(
        checked
          .filter((c) => c.isMine)
          .map(({ row }) => ({
            timesheetId: row.id,
            department: row.department,
            month: row.month,
            year: row.year,
            staffName: row.profiles?.full_name ?? "Unknown staff",
          })),
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <h1 className="text-xl font-semibold">Returned items</h1>
        <SignOutButton />
      </div>

      {loading && <p className="text-sm text-text-secondary">Loading…</p>}
      {error && <p className="text-sm text-returning">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-text-secondary">Nothing needs your acknowledgment right now.</p>
      )}

      {!loading && items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.timesheetId}>
              <Link
                href={`/returned-items/${item.timesheetId}`}
                className="flex items-center justify-between rounded-xl border border-border bg-surface p-4 hover:border-border-strong"
              >
                <div>
                  <p className="text-sm font-medium">{item.staffName}</p>
                  <p className="text-xs text-text-secondary">
                    {DEPARTMENT_LABEL[item.department]} · {monthLabel(item.year, item.month)}
                  </p>
                </div>
                <span className="text-xs font-medium text-text-muted">Acknowledge return</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
