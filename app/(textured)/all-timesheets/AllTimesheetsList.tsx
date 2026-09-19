"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { fetchPendingFinalApprovers, type PendingFinalMap } from "@/lib/pendingApprovers";
import {
  type Department,
  type TimesheetStatus,
  DEPARTMENT_LABEL,
  timesheetStatusLabel,
  monthLabel,
} from "@/lib/timesheet";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type Row = {
  id: string;
  department: Department;
  month: number;
  year: number;
  status: TimesheetStatus;
  profiles: { full_name: string; hr_number: string | null } | null;
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
  const [pendingFinal, setPendingFinal] = useState<PendingFinalMap>({});

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
        .select("id, department, month, year, status, profiles(full_name, hr_number)")
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

      const loaded = (data ?? []) as unknown as Row[];
      const finalPendingMap = await fetchPendingFinalApprovers(
        supabase,
        loaded.filter((row) => row.status === "pending_final_review").map((row) => row.id),
      );
      if (cancelled) return;

      setPendingFinal(finalPendingMap);
      setRows(loaded);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, department, status]);

  const visibleRows = rows.filter((row) => {
    const query = staffQuery.trim().toLowerCase();
    if (!query) return true;
    const name = row.profiles?.full_name ?? "";
    const hrNumber = row.profiles?.hr_number ?? "";
    return name.toLowerCase().includes(query) || hrNumber.toLowerCase().includes(query);
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold">All timesheets</h1>
            <p className="text-sm text-text-secondary">Every timesheet across every department.</p>
          </div>
        </div>
        <SignOutButton />
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          id="staff-search"
          type="text"
          value={staffQuery}
          onChange={(e) => setStaffQuery(e.target.value)}
          placeholder="Search staff name or HR number"
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
                className="flex flex-col gap-2 rounded-xl border border-border border-l-4 border-l-accent bg-surface p-4 transition-colors hover:border-border-strong hover:border-l-accent-on-tint sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex flex-1 items-center gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-on-tint">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{row.profiles?.full_name ?? "Unknown staff"}</p>
                    <p className="text-xs text-text-secondary">
                      {DEPARTMENT_LABEL[row.department]} · {monthLabel(row.year, row.month)}
                    </p>
                  </div>
                </div>
                {/* Under the name on narrow screens (pl-14 = icon 40px + gap
                    16px, aligning with the text column); right-aligned beside
                    it from sm up. A long role-aware label like "Awaiting SPM &
                    HR's Review" otherwise squeezes the name into a sliver. */}
                <span className="pl-14 text-xs font-medium text-text-secondary sm:pl-0 sm:text-right">
                  {timesheetStatusLabel(row.status, row.department, pendingFinal[row.id])}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
