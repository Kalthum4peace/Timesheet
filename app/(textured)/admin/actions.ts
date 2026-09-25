"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deactivateStaff, type DeactivateResult } from "@/lib/staffAdmin";
import { createStaffAccount, type CreateStaffResult } from "@/lib/createStaff";

// The rules for creating an account live in lib/createStaff.ts so this action
// and scripts/bulk-import-medical.mjs run the exact same code. This action
// only owns what is specific to the form: who is calling, and FormData.
export type { CreateStaffResult };

export async function createStaffMember(
  _prev: CreateStaffResult,
  formData: FormData,
): Promise<CreateStaffResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Not signed in." };
  }

  // Re-verified here, server-side, against the caller's own session — never
  // trust that only the UI hid this form from non-admins. Same lesson as
  // current_return_recipient's authorization check.
  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (callerProfile?.role !== "admin" && callerProfile?.role !== "admin_hr") {
    return { ok: false, error: "Only an admin can create staff members." };
  }

  const field = (name: string) => String(formData.get(name) ?? "");
  const result = await createStaffAccount(
    createAdminClient(),
    {
      fullName: field("fullName").trim(),
      email: field("email").trim(),
      hrNumber: field("hrNumber").trim(),
      location: field("location").trim(),
      role: field("role"),
      password: field("password"),
      department: field("department"),
      teamLeadId: field("teamLeadId"),
      departmentHeadId: field("departmentHeadId"),
    },
    user.id,
  );

  if (result.ok) revalidatePath("/admin");
  return result;
}

// Thin wrapper: every rule (admin-only, no self-deactivation, in-flight work
// guard, flag + login ban with rollback) lives in lib/staffAdmin.ts so the
// exact same code is what scripts/test-deactivate.mjs exercises.
export async function deactivateStaffMember(targetId: string): Promise<DeactivateResult> {
  const result = await deactivateStaff(await createClient(), createAdminClient(), targetId);
  if (result.ok) revalidatePath("/admin");
  return result;
}
