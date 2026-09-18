import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AddStaffForm } from "./AddStaffForm";

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

  return <AddStaffForm teamLeads={teamLeads ?? []} departmentHeads={departmentHeads ?? []} />;
}
