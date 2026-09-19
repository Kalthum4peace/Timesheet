import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RosterList } from "./RosterList";

const ROSTER_ROLES = ["team_lead", "department_head", "spm", "hr", "admin_hr"];

export default async function RosterPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !ROSTER_ROLES.includes(profile.role)) {
    redirect("/timesheet");
  }

  return (
    <RosterList
      userId={user.id}
      role={profile.role as "team_lead" | "department_head" | "spm" | "hr" | "admin_hr"}
    />
  );
}
