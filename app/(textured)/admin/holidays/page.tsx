import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminTabs } from "../AdminTabs";
import { HolidaysManager, type Holiday } from "./HolidaysManager";

export default async function HolidaysPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin" && profile?.role !== "admin_hr") redirect("/timesheet");

  const { data: rows } = await supabase
    .from("public_holidays")
    .select("id, date, name, scope")
    .order("date", { ascending: true });

  const all = rows ?? [];
  const orgHolidays: Holiday[] = all.filter((r) => r.scope === "org");
  const nationalHolidays: Holiday[] = all.filter((r) => r.scope === "national");

  return (
    <div className="flex flex-col gap-6">
      <AdminTabs />
      <HolidaysManager orgHolidays={orgHolidays} nationalHolidays={nationalHolidays} />
    </div>
  );
}
