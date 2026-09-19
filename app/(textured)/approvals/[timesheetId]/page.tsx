import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ApprovalDetail } from "./ApprovalDetail";

export default async function ApprovalDetailPage({
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

  return <ApprovalDetail userId={user.id} timesheetId={timesheetId} />;
}
