import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReturnedItemsList } from "./ReturnedItemsList";

export default async function ReturnedItemsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <ReturnedItemsList userId={user.id} />;
}
