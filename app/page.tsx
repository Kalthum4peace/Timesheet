import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Admin has no timesheet chain of its own — see login page for the same
  // reasoning.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  redirect(profile?.role === "admin" ? "/admin" : "/timesheet");
}
