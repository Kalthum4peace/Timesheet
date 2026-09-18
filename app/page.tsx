import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const APPROVER_ROLES = ["team_lead", "department_head", "spm", "hr", "admin_hr"];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Plain admin has no timesheet chain of its own, and approver roles have
  // no organizational_assignments row of their own either — see login page
  // for the same reasoning. admin_hr is deliberately routed like the other
  // approver roles (lands on /approvals, reaches /admin via nav) rather
  // than like plain admin — it DOES have its own timesheet chain (see
  // generate_approval_chain), same as hr already does.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role && APPROVER_ROLES.includes(profile.role)) redirect("/approvals");
  redirect("/timesheet");
}
