"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  type Department,
  type TimesheetStatus,
  DEPARTMENT_LABEL,
  TIMESHEET_STATUS_LABEL,
  monthLabel,
} from "@/lib/timesheet";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type Row = {
  id: string;
  department: Department;
  month: number;
  year: number;
  status: TimesheetStatus;
  profiles: { full_name: string } | null;
};

const DEPARTMENT_FILTERS: { value: Department | "all"; label: string }[] = [
  { value: "all", label: "All departments" },
  { value: "medical", label: "Medical" },
  { value: "operations", label: "Operations" },
];

const STATUS_FILTERS: { value: TimesheetStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_team_lead", label: "Pending team lead" },
  { value: "pending_department_head", label: "Pending department head" },
  { value: "pending_final_review", label: "Pending final review" },
  { value: "returning", label: "Returning" },
  { value: "approved", label: "Approved" },
];

export function AllTimesheetsList() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  const [department, setDepartment] = useState<Department | "all">("all");
  const [status, setStatus] = useState<TimesheetStatus | "all">("all");
  const [staffQuery, setStaffQuery] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      let query = supabase
        .from("timesheets")
        .select("id, department, month, year, status, profiles(full_name)")
        .order("year", { ascending: false })
        .order("month", { ascending: false });

      if (department !== "all") query = query.eq("department", department);
      if (status !== "all") query = query.eq("status", status);

      const { data, error: fetchError } = await query;
      if (cancelled) return;
      if (fetchError) {
        setError("Couldn't load timesheets.");
        setLoading(false);
        return;
      }

      setRows((data ?? []) as unknown as Row[]);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, department, status]);

  const visibleRows = rows.filter((row) => {
    if (!staffQuery.trim()) return true;
    const name = row.profiles?.full_name ?? "";
    return name.toLowerCase().includes(staffQuery.trim().toLowerCase());
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <h1 className="text-xl font-semibold">All timesheets</h1>
        <SignOutButton />
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          id="staff-search"
          type="text"
          value={staffQuery}
          onChange={(e) => setStaffQuery(e.target.value)}
          placeholder="Search staff name"
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <select
          id="department-filter"
          value={department}
          onChange={(e) => setDepartment(e.target.value as Department | "all")}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {DEPARTMENT_FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          id="status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value as TimesheetStatus | "all")}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {STATUS_FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="text-sm text-text-secondary">Loading…</p>}
      {error && <p className="text-sm text-returning">{error}</p>}

      {!loading && !error && visibleRows.length === 0 && (
        <p className="text-sm text-text-secondary">No timesheets match these filters.</p>
      )}

      {!loading && visibleRows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visibleRows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/all-timesheets/${row.id}`}
                className="flex items-center justify-between rounded-xl border border-border bg-surface p-4 hover:border-border-strong"
              >
                <div>
                  <p className="text-sm font-medium">{row.profiles?.full_name ?? "Unknown staff"}</p>
                  <p className="text-xs text-text-secondary">
                    {DEPARTMENT_LABEL[row.department]} · {monthLabel(row.year, row.month)}
                  </p>
                </div>
                <span className="text-xs font-medium text-text-muted">
                  {TIMESHEET_STATUS_LABEL[row.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
