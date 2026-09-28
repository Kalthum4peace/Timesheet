import type { Department } from "@/lib/timesheet";

// Which department a leader's OWN timesheet is filed under.
//
// timesheets.department is NOT NULL and is normally snapshotted from the
// person's organizational_assignments row. Leaders never have one (Add Staff
// only creates it for role = 'staff'), and generate_approval_chain doesn't need
// it for them: their chain is the self-routing branch. So the value is fixed by
// role, per the confirmed org structure:
//   team_lead, department_head -> medical    (Operations has no team leads or
//                                              department heads by design)
//   spm, admin_hr              -> operations
// Any other role returns null and keeps the assignment-based path unchanged —
// notably plain 'admin' (oversight only, no timesheet of its own) and 'staff'.
const LEADERSHIP_DEPARTMENT: Record<string, Department> = {
  team_lead: "medical",
  department_head: "medical",
  spm: "operations",
  admin_hr: "operations",
};

export function leadershipDepartment(role: string): Department | null {
  return LEADERSHIP_DEPARTMENT[role] ?? null;
}
