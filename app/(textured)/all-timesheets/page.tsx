import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AllTimesheetsList } from "./AllTimesheetsList";

export default async function AllTimesheetsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "hr" && profile?.role !== "admin_hr") {
    redirect("/timesheet");
  }

  return <AllTimesheetsList />;
}
