"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchPendingFinalApprovers } from "@/lib/pendingApprovers";
import {
  type ApprovalType,
  type Department,
  type TimesheetStatus,
  DEPARTMENT_LABEL,
  timesheetStatusLabel,
} from "@/lib/timesheet";

type Role = "team_lead" | "department_head" | "spm" | "hr" | "admin_hr";

type AssignmentRow = {
  staff_id: string;
  department: Department;
  profiles: { full_name: string; hr_number: string | null; role: string } | null;
};

type TimesheetRow = {
  id: string;
  staff_id: string;
  status: TimesheetStatus;
  department: Department;
};

type RosterItem = {
  staffId: string;
  fullName: string;
  hrNumber: string | null;
  department: Department;
  status: TimesheetStatus | null;
  stillPendingFinal: ApprovalType[] | undefined;
};

const DEPARTMENT_FILTERS: { value: Department | "all"; label: string }[] = [
  { value: "all", label: "All departments" },
  { value: "medical", label: "Medical" },
  { value: "operations", label: "Operations" },
];

// "Not submitted" isn't itself a TimesheetStatus — it's the absence of a
// row, per this item's own derivation rule (no new table). Reusing the
// existing `returning` chip tone for it rather than inventing a new color:
// both mean "this needs the staff member's attention," and the locked
// design direction bans introducing colors outside the three already
// confirmed for approver-scanning lists (see CLAUDE.md "Design direction").
function chipTone(status: TimesheetStatus | null): "pending" | "returning" | "approved" {
  if (status === null) return "returning";
  if (status === "returning") return "returning";
  if (status === "approved") return "approved";
  return "pending";
}

const CHIP_CLASS: Record<"pending" | "returning" | "approved", string> = {
  pending: "bg-pending-bg text-pending",
  returning: "bg-returning-bg text-returning",
  approved: "bg-approved-bg text-approved",
};

export function RosterList({ userId, role }: { userId: string; role: Role }) {
  const supabase = useMemo(() => createClient(), []);
  const now = useMemo(() => new Date(), []);
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<RosterItem[]>([]);

  const [department, setDepartment] = useState<Department | "all">("all");
  const [staffQuery, setStaffQuery] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // Current assignment scope only (effective_to is null) — this is a
      // "who is on my team right now" screen, unlike approval_steps/
      // timesheets visibility which deliberately also covers historical
      // relationships. Scope narrows by role, mirroring the same boundary
      // already used for approval/visibility elsewhere: team_lead_id/
      // department_head_id = caller for Team Lead/Department Head, and no
      // extra staff filter for SPM/HR — matching timesheets_select's own
      // "spm/hr see every department" rule.
      let query = supabase
        .from("organizational_assignments")
        .select("staff_id, department, profiles!organizational_assignments_staff_id_fkey(full_name, hr_number, role)")
        .is("effective_to", null);

      if (role === "team_lead") query = query.eq("team_lead_id", userId);
      else if (role === "department_head") query = query.eq("department_head_id", userId);
      if (department !== "all") query = query.eq("department", department);

      const { data: assignments, error: assignmentsError } = await query;
      if (cancelled) return;
      if (assignmentsError) {
        setError("Couldn't load your staff roster.");
        setLoading(false);
        return;
      }

      // Only real staff — SPM/HR's unfiltered query also picks up other
      // approvers' own placeholder assignment rows (department only, no
      // reports of their own), which don't belong on a "staff roster."
      const staffRows = (assignments as unknown as AssignmentRow[]).filter(
        (row) => row.profiles?.role === "staff",
      );
      const staffIds = staffRows.map((row) => row.staff_id);

      let timesheetByStaff = new Map<string, TimesheetRow>();
      if (staffIds.length > 0) {
        const { data: timesheets, error: timesheetsError } = await supabase
          .from("timesheets")
          .select("id, staff_id, status, department")
          .eq("month", currentMonth)
          .eq("year", currentYear)
          .in("staff_id", staffIds);
        if (cancelled) return;
        if (timesheetsError) {
          setError("Couldn't load this month's timesheet status.");
          setLoading(false);
          return;
        }
        timesheetByStaff = new Map((timesheets as TimesheetRow[]).map((t) => [t.staff_id, t]));
      }

      const finalPendingMap = await fetchPendingFinalApprovers(
        supabase,
        [...timesheetByStaff.values()].filter((t) => t.status === "pending_final_review").map((t) => t.id),
      );
      if (cancelled) return;

      setItems(
        staffRows.map((row) => {
          const ts = timesheetByStaff.get(row.staff_id);
          return {
            staffId: row.staff_id,
            fullName: row.profiles?.full_name ?? "Unknown staff",
            hrNumber: row.profiles?.hr_number ?? null,
            department: row.department,
            status: ts?.status ?? null,
            stillPendingFinal: ts ? finalPendingMap[ts.id] : undefined,
          };
        }),
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, role, department, currentMonth, currentYear]);

  const visibleItems = items
    .filter((item) => {
      const query = staffQuery.trim().toLowerCase();
      if (!query) return true;
      return (
        item.fullName.toLowerCase().includes(query) ||
        (item.hrNumber ?? "").toLowerCase().includes(query)
      );
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const notSubmittedCount = visibleItems.filter((item) => item.status === null).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold">Staff roster</h1>
            <p className="text-sm text-text-secondary">
              {new Date(currentYear, currentMonth - 1, 1).toLocaleDateString("en-US", {
                month: "long",
                year: "numeric",
              })}
              {" · "}
              {notSubmittedCount} of {visibleItems.length} not yet submitted
            </p>
          </div>
        </div>
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
      </div>

      {loading && <p className="text-sm text-text-secondary">Loading…</p>}
      {error && <p className="text-sm text-returning">{error}</p>}

      {!loading && !error && visibleItems.length === 0 && (
        <p className="text-sm text-text-secondary">No staff in scope right now.</p>
      )}

      {!loading && visibleItems.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visibleItems.map((item) => (
            <li
              key={item.staffId}
              className="flex items-center justify-between rounded-xl border border-border bg-surface p-4"
            >
              <div>
                <p className="text-sm font-medium">{item.fullName}</p>
                <p className="text-xs text-text-secondary">
                  {DEPARTMENT_LABEL[item.department]}
                  {item.hrNumber ? ` · HR# ${item.hrNumber}` : ""}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${CHIP_CLASS[chipTone(item.status)]}`}
              >
                {item.status === null
                  ? "Not submitted"
                  : timesheetStatusLabel(item.status, item.department, item.stillPendingFinal)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
