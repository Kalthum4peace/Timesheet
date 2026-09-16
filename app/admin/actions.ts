"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type CreateStaffResult = { ok: true } | { ok: false; error: string };

const VALID_ROLES = ["staff", "team_lead", "department_head", "spm", "hr", "admin"];

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
  if (callerProfile?.role !== "admin") {
    return { ok: false, error: "Only an admin can create staff members." };
  }

  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const password = String(formData.get("password") ?? "");
  const department = String(formData.get("department") ?? "");
  const teamLeadId = String(formData.get("teamLeadId") ?? "");
  const departmentHeadId = String(formData.get("departmentHeadId") ?? "");

  if (!fullName || !email || !location || !role || !password) {
    return { ok: false, error: "Fill in all required fields." };
  }
  if (password.length < 8) {
    return { ok: false, error: "Temporary password must be at least 8 characters." };
  }
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: "Invalid role." };
  }
  if (role === "staff" && (!department || !teamLeadId || !departmentHeadId)) {
    return { ok: false, error: "Staff members need a department, team lead, and department head." };
  }

  const admin = createAdminClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    return { ok: false, error: createError?.message ?? "Couldn't create the account." };
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: created.user.id,
    full_name: fullName,
    email,
    location,
    role,
  });
  if (profileError) {
    // Roll back the auth user so a failed profile insert doesn't leave an
    // orphaned account with no profile behind.
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, error: "Couldn't create the profile: " + profileError.message };
  }

  if (role === "staff") {
    const { error: assignmentError } = await admin.from("organizational_assignments").insert({
      staff_id: created.user.id,
      team_lead_id: teamLeadId,
      department_head_id: departmentHeadId,
      department,
      effective_from: new Date().toISOString().slice(0, 10),
      created_by: user.id,
    });
    if (assignmentError) {
      await admin.from("profiles").delete().eq("id", created.user.id);
      await admin.auth.admin.deleteUser(created.user.id);
      return {
        ok: false,
        error: "Couldn't create the organizational assignment: " + assignmentError.message,
      };
    }
  }

  return { ok: true };
}
