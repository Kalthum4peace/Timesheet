import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PendingApprovalsList } from "./PendingApprovalsList";

export default async function ApprovalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <PendingApprovalsList userId={user.id} />;
}
