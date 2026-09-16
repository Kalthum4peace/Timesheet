import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AllTimesheetsDetail } from "./AllTimesheetsDetail";

export default async function AllTimesheetsDetailPage({
  params,
}: {
  params: Promise<{ timesheetId: string }>;
}) {
  const { timesheetId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "hr") {
    redirect("/timesheet");
  }

  return <AllTimesheetsDetail timesheetId={timesheetId} />;
}
