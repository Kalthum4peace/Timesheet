import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AddStaffForm } from "./AddStaffForm";
import { StaffList, type StaffMember } from "./StaffList";
import { AdminTabs } from "./AdminTabs";
import type { Department } from "@/lib/timesheet";

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin" && profile?.role !== "admin_hr") {
    redirect("/timesheet");
  }

  const { data: teamLeads } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "team_lead")
    .eq("active", true)
    .order("full_name");

  const { data: departmentHeads } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "department_head")
    .eq("active", true)
    .order("full_name");

  // Whole roster, active first. Admin/admin_hr can read every profile and
  // every organizational_assignments row (profiles_select /
  // org_assignments_select), so this is the caller's own RLS doing the
  // scoping, not a service-role read.
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, active")
    .order("active", { ascending: false })
    .order("full_name");

  const { data: assignments } = await supabase
    .from("organizational_assignments")
    .select("staff_id, department")
    .is("effective_to", null);
  const departmentByStaff = new Map((assignments ?? []).map((a) => [a.staff_id, a.department as Department]));

  const members: StaffMember[] = (profiles ?? []).map((p) => ({
    id: p.id,
    fullName: p.full_name,
    email: p.email,
    role: p.role,
    department: p.role === "staff" ? (departmentByStaff.get(p.id) ?? null) : null,
    active: p.active,
  }));

  return (
    <div className="flex flex-col gap-10">
      <AdminTabs />
      <AddStaffForm teamLeads={teamLeads ?? []} departmentHeads={departmentHeads ?? []} />
      <StaffList members={members} currentUserId={user.id} />
    </div>
  );
}
