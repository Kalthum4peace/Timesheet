import type { SupabaseClient } from "@supabase/supabase-js";

// Staff-account creation, kept free of Next.js imports and taking the
// service-role client as an argument so the exact same code runs from the Add
// Staff server action AND from scripts/bulk-import-medical.mjs (Node runs this
// file directly via type stripping, hence erasable TypeScript only — no
// enums, no parameter properties). Every business rule for creating an
// account lives here and nowhere else.
//
// AUTHORIZATION IS THE CALLER'S JOB. This function trusts `createdBy`: the
// server action verifies the signed-in caller is admin/admin_hr first; the
// bulk script verifies the acting admin profile before it starts.

export type CreateStaffInput = {
  fullName: string;
  email: string;
  hrNumber?: string;
  location: string;
  role: string;
  password: string;
  department?: string;
  teamLeadId?: string;
  departmentHeadId?: string;
};

export type CreateStaffResult = { ok: true; userId?: string } | { ok: false; error: string };

// "hr" is deliberately absent: plain hr is retired for new accounts (the HR
// position is always admin_hr now). Enforced here, not just by hiding the
// option in the form — the UI is never the boundary. Existing hr-role
// profiles are unaffected; this only governs what gets created.
export const VALID_ROLES = ["staff", "team_lead", "department_head", "spm", "admin", "admin_hr"];

export async function createStaffAccount(
  admin: SupabaseClient,
  input: CreateStaffInput,
  createdBy: string,
): Promise<CreateStaffResult> {
  const { fullName, email, location, role, password, department } = input;
  const hrNumber = input.hrNumber ?? "";
  const teamLeadId = input.teamLeadId ?? "";
  const departmentHeadId = input.departmentHeadId ?? "";

  if (!fullName || !email || !location || !role || !password) {
    return { ok: false, error: "Fill in all required fields." };
  }
  if (password.length < 8) {
    return { ok: false, error: "Temporary password must be at least 8 characters." };
  }
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: "Invalid role." };
  }
  if (role === "staff") {
    if (!department) {
      return { ok: false, error: "Staff members need a department." };
    }
    // Operations has no team lead / department head layer: its staff route
    // straight to SPM + HR (generate_approval_chain, 20260925000000). Both
    // blank is valid there; exactly one is not, because the chain rule would
    // silently drop the one that was chosen. Medical always needs both.
    if (department === "operations") {
      if (!teamLeadId !== !departmentHeadId) {
        return {
          ok: false,
          error: "Operations staff need either both a team lead and a department head, or neither.",
        };
      }
    } else if (!teamLeadId || !departmentHeadId) {
      return { ok: false, error: "Staff members need a department, team lead, and department head." };
    }
  }

  // generate_approval_chain requires exactly ONE active HR-position profile
  // (role hr OR admin_hr) and hard-fails every submission at 2, with no
  // in-app way to recover yet. Checked here, before anything is created, so
  // a rejection writes nothing. Fails closed if the check itself errors. Not
  // race-proof (two simultaneous submits could both pass) — the partial
  // unique index profiles_one_active_hr_position is the database backstop.
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
    // Explicit even though the column now defaults to true: the first
    // sign-in with this temporary password must force a new one.
    must_change_password: true,
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
      team_lead_id: teamLeadId || null,
      department_head_id: departmentHeadId || null,
      department,
      effective_from: new Date().toISOString().slice(0, 10),
      created_by: createdBy,
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

  return { ok: true, userId: created.user.id };
}
