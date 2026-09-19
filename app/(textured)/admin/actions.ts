"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type CreateStaffResult = { ok: true } | { ok: false; error: string };

// "hr" is deliberately absent: plain hr is retired for new accounts (the HR
// position is always admin_hr now). Enforced here, not just by hiding the
// option in the form — same rule as the admin-only check below, the UI is
// never the boundary. Existing hr-role profiles are unaffected; this only
// governs what this action will create.
const VALID_ROLES = ["staff", "team_lead", "department_head", "spm", "admin", "admin_hr"];

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

  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const hrNumber = String(formData.get("hrNumber") ?? "").trim();
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

  // generate_approval_chain requires exactly ONE active HR-position profile
  // (role hr OR admin_hr) and hard-fails every submission at 2, with no
  // in-app way to recover yet. Checked here, before anything is created, so
  // a rejection writes nothing. Fails closed if the check itself errors. Not
  // race-proof (two simultaneous submits could both pass) — a partial unique
  // index would be, but that's a schema change; this covers the real case.
  if (role === "admin_hr") {
    const { count, error: hrCheckError } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("role", ["hr", "admin_hr"])
      .eq("active", true);
    if (hrCheckError) {
      return { ok: false, error: "Couldn't check for an existing HR/Admin account: " + hrCheckError.message };
    }
    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: "An active HR/Admin account already exists — deactivate the existing one first.",
      };
    }
  }

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
    hr_number: hrNumber || null,
    location,
    role,
  });
  if (profileError) {
    // Roll back the auth user so a failed profile insert doesn't leave an
    // orphaned account with no profile behind.
    await admin.auth.admin.deleteUser(created.user.id);
    // profiles_one_active_hr_position is the database-level backstop for the
    // check above: it's what rejects the loser when two HR/Admin creations
    // race past the application check at the same moment.
    return {
      ok: false,
      error: profileError.message.includes("profiles_hr_number_unique")
        ? "That HR number is already assigned to another staff member."
        : profileError.message.includes("profiles_one_active_hr_position")
          ? "An active HR/Admin account already exists — deactivate the existing one first."
          : "Couldn't create the profile: " + profileError.message,
    };
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
