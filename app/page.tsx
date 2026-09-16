import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const APPROVER_ROLES = ["team_lead", "department_head", "spm", "hr"];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Admin has no timesheet chain of its own, and approver roles have no
  // organizational_assignments row of their own either — see login page
  // for the same reasoning.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role && APPROVER_ROLES.includes(profile.role)) redirect("/approvals");
  redirect("/timesheet");
}
