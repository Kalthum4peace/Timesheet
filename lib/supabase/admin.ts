import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS entirely. Server-only: SUPABASE_SERVICE_ROLE_KEY
// has no NEXT_PUBLIC_ prefix, so it is never bundled to the browser, but this
// file itself must never be imported from a "use client" component. Every
// caller is responsible for re-verifying the requesting user's own role
// (via the regular cookie-bound server client) BEFORE using this — this
// client trusts nothing on its own, same lesson as current_return_recipient's
// authorization check.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
