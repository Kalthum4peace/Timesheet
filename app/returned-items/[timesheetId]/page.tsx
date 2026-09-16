import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReturnedItemDetail } from "./ReturnedItemDetail";

export default async function ReturnedItemDetailPage({
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

  return <ReturnedItemDetail userId={user.id} timesheetId={timesheetId} />;
}
