"use server";

import { redirect } from "next/navigation";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateNewPassword } from "@/lib/password";

export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

// Used for BOTH the forced first-login screen and the ordinary "Change
// password" page. The current password is always required (and re-verified
// here, not trusted from the client): it proves the person at the keyboard
// knows it, and it lets us refuse a "new" password identical to the temporary
// one.
export async function changePassword(
  _prev: ChangePasswordResult,
  formData: FormData,
): Promise<ChangePasswordResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return { ok: false, error: "Not signed in." };

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!current) return { ok: false, error: "Enter your current password." };
  const invalid = validateNewPassword(next, confirm, current);
  if (invalid) return { ok: false, error: invalid };

  // Re-verify the current password on a throwaway client so this doesn't
  // touch the caller's own session cookies.
  const verifier = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: verifyError } = await verifier.auth.signInWithPassword({ email: user.email, password: current });
  if (verifyError) return { ok: false, error: "Your current password is incorrect." };

  // Was this the forced first-login change? Read before we clear it. Own-row
  // SELECT is allowed by profiles_select for the caller.
  const { data: profile } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", user.id)
    .single();
  const wasForced = !!profile?.must_change_password;

  const { error: updateError } = await supabase.auth.updateUser({ password: next });
  if (updateError) return { ok: false, error: updateError.message };

  // Clear the gate with the service role: ordinary users have no UPDATE
  // policy on profiles, so this is the only route that can lower the flag.
  // Only reached after the password really changed. Scoped to the caller's
  // own id, which comes from the verified session above, never from the form.
  const admin = createAdminClient();
  const { error: clearError } = await admin
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", user.id);
  if (clearError) {
    return {
      ok: false,
      error: "Your password was changed, but we couldn't finish signing you in. Sign out and sign in with the new password.",
    };
  }

  if (wasForced) redirect("/");
  return { ok: true };
}
