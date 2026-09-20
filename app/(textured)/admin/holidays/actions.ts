"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type HolidayResult = { ok: true } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both actions run through the CALLER's own RLS-bound client, not the
// service role: what an admin can do to public_holidays is decided by the
// database (public_holidays_insert_admin / public_holidays_delete_org — org
// scope only, admin/admin_hr only), and this code only adds the friendly
// messages. The role check up front is for a clear error, not the boundary.
type AdminContext =
  | { ok: false; error: string }
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string } };

async function requireAdmin(): Promise<AdminContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin" && profile?.role !== "admin_hr") {
    return { ok: false, error: "Only an admin can manage public holidays." };
  }
  return { ok: true, supabase, user };
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function addHoliday(_prev: HolidayResult, formData: FormData): Promise<HolidayResult> {
  const ctx = await requireAdmin();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { supabase, user } = ctx;

  const date = String(formData.get("date") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  if (!isRealDate(date)) return { ok: false, error: "Choose a valid date." };
  const year = Number(date.slice(0, 4));
  if (year < 2020 || year > 2100) return { ok: false, error: "Choose a date between 2020 and 2100." };
  if (!name) return { ok: false, error: "Enter the holiday's name." };
  if (name.length > 100) return { ok: false, error: "Keep the name to 100 characters or fewer." };

  // National holidays are seed data. Adding the same day again as an
  // organisation holiday would just show it twice, so say so instead.
  const { data: national } = await supabase
    .from("public_holidays")
    .select("name")
    .eq("date", date)
    .eq("scope", "national")
    .maybeSingle();
  if (national) {
    return { ok: false, error: `That date is already a national public holiday (${national.name}).` };
  }

  const { error } = await supabase
    .from("public_holidays")
    .insert({ date, name, scope: "org", created_by: user.id });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "You've already added a holiday on that date." };
    return { ok: false, error: "Couldn't add the holiday: " + error.message };
  }

  revalidatePath("/admin/holidays");
  return { ok: true };
}

export async function deleteHoliday(id: string): Promise<HolidayResult> {
  const ctx = await requireAdmin();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  if (!UUID_RE.test(id)) return { ok: false, error: "That holiday doesn't exist." };

  // The scope filter here is belt-and-braces: the database policy already
  // refuses to delete anything but scope = 'org', so a national row that
  // somehow reached this call would simply match zero rows.
  const { data, error } = await ctx.supabase
    .from("public_holidays")
    .delete()
    .eq("id", id)
    .eq("scope", "org")
    .select("id");
  if (error) return { ok: false, error: "Couldn't remove the holiday: " + error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "That holiday can't be removed — it may already be gone, or it's a national holiday." };
  }

  revalidatePath("/admin/holidays");
  return { ok: true };
}
