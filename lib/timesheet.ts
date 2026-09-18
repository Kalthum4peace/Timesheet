export type AttendanceStatus = "present" | "absent" | "public_holiday" | "leave";

export type TimesheetStatus =
  | "draft"
  | "pending_team_lead"
  | "pending_department_head"
  | "pending_final_review"
  | "returning"
  | "approved";

export type Department = "medical" | "operations";

export type ApprovalType = "team_lead" | "department_head" | "spm" | "hr";

export const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  team_lead: "Team lead",
  department_head: "Department head",
  spm: "SPM",
  hr: "HR",
};

// Which timesheet_status means "this approval_type's step is the one
// currently active." Mirrors approve_timesheet's own status-tagging exactly
// (status reflects layer TYPE, not step_order position — spm and hr share
// step_order but both map to pending_final_review).
//
// This is the ONLY reliable way for the client to tell whether a `pending`
// approval_steps row is genuinely actionable. Approval_steps RLS only lets
// a caller see their OWN row (or, for staff, their own timesheet's rows) —
// so a client-side query trying to check "is an earlier step_order still
// pending" by reading sibling rows silently comes back empty for every
// OTHER approver's row and always looks falsely clear. The timesheet's own
// status is visible to every approver on it (per timesheets RLS) and is
// exactly the aggregate signal chain-generation/approve/decline already
// maintain for this purpose — use it instead of re-deriving order from
// rows the caller isn't allowed to read.
export const APPROVAL_TYPE_ACTIVE_STATUS: Record<ApprovalType, TimesheetStatus> = {
  team_lead: "pending_team_lead",
  department_head: "pending_department_head",
  spm: "pending_final_review",
  hr: "pending_final_review",
};

export const STATUS_OPTIONS: { value: AttendanceStatus; label: string; code: string }[] = [
  { value: "present", label: "Present", code: "P" },
  { value: "absent", label: "Absent", code: "A" },
  { value: "public_holiday", label: "Public holiday", code: "PH" },
  { value: "leave", label: "Leave", code: "L" },
];

export const TIMESHEET_STATUS_LABEL: Record<TimesheetStatus, string> = {
  draft: "Draft — not yet submitted",
  pending_team_lead: "Submitted — awaiting team lead",
  pending_department_head: "Awaiting department head",
  pending_final_review: "Awaiting final review",
  returning: "Returned — edit and resubmit",
  approved: "Approved",
};

export const DEPARTMENT_LABEL: Record<Department, string> = {
  medical: "Medical",
  operations: "Operations",
};

// department_head is one application role shared across departments (see
// PROJECT_CONTEXT §3), but the client wants the title shown to reflect
// which department a given instance is for — "Head of Medical" / "Head of
// Operations" — rather than the generic role name. Only meaningful once a
// specific timesheet/step's department is known, so these are functions of
// department rather than a static label map like APPROVAL_TYPE_LABEL/
// TIMESHEET_STATUS_LABEL above (which stay as generic fallbacks for
// contexts with no department in hand, e.g. a bare role picker).
export function departmentHeadLabel(department: Department): string {
  return department === "medical" ? "Head of Medical" : "Head of Operations";
}

export function approvalTypeLabel(type: ApprovalType, department: Department): string {
  if (type === "department_head") return departmentHeadLabel(department);
  return APPROVAL_TYPE_LABEL[type];
}

export function timesheetStatusLabel(status: TimesheetStatus, department: Department): string {
  if (status === "pending_department_head") return `Awaiting ${departmentHeadLabel(department)}`;
  return TIMESHEET_STATUS_LABEL[status];
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

export function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function leadingBlanksForMonth(year: number, month: number) {
  return (new Date(year, month - 1, 1).getDay() + 6) % 7;
}

export function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
