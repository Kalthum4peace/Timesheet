import type { SupabaseClient } from "@supabase/supabase-js";

// "Today" as the DATABASE sees it, as a YYYY-MM-DD key (same shape as dateKey).
//
// attendance_entries rejects any row dated after public.app_today()
// (migration 20260928000000), so the UI must decide which days to offer from
// the same clock — not the browser's. In Nigeria (UTC+1) the local date runs
// ahead of the database's for the first hour of each day, and a day the
// browser thinks is fillable but the database still calls "tomorrow" would
// make the whole save-draft batch fail.
//
// If the call fails (network, or the function is not deployed yet) this
// falls back to the UTC date, which is exactly what app_today() returns
// unless someone changes that function to another time zone on purpose.
export async function fetchAppToday(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("app_today");
  if (!error && typeof data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data)) return data;
  return new Date().toISOString().slice(0, 10);
}
