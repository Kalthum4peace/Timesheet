import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TimesheetForm } from "./TimesheetForm";

export default async function TimesheetPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <TimesheetForm userId={user.id} />;
}
