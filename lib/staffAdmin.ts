import type { SupabaseClient } from "@supabase/supabase-js";

// Deactivation logic, kept free of Next.js imports and taking its two
// Supabase clients as arguments so the exact same code runs from the Server
// Action (cookie-bound caller + service-role admin) and from
// scripts/test-deactivate.mjs (real signed-in caller + service-role admin).
// Node runs this file directly (type stripping), which is why it uses only
// erasable TypeScript — no enums, no parameter properties.
//
// WHY THIS DOES MORE THAN FLIP profiles.active: nothing in the database
// treats a profile's `active = false` as "cannot sign in" or "cannot act".
// RLS and the workflow RPCs never read it for the caller (only chain
// generation reads it, and only to pick the single SPM / HR-position
// account). Supabase Auth has no idea the column exists. So a bare flag flip
// would leave a deactivated person fully able to sign in. The login block is
// the Auth-level ban applied below.

export type DeactivateResult = { ok: true } | { ok: false; error: string };

// GoTrue takes a Go-style duration; ~100 years. Reversible (`"none"`), which
// a future reactivate action can use — nothing is deleted.
const BAN_DURATION = "876000h";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = ["admin", "admin_hr"];
const LIVE_TIMESHEET_STATUSES = ["pending_team_lead", "pending_department_head", "pending_final_review"];

// Deactivating someone who still has live work leaves that work stranded
// with no in-app way to recover: approval_steps.approver_id is a fixed
// snapshot (a replacement can't inherit it), and generate_approval_chain
// takes team lead / department head from organizational_assignments WITHOUT
// checking `active`, so it would keep routing new timesheets to a banned
// account. This refuses instead of stranding. Known gap, deliberately not
// covered: a `returning` timesheet whose return path still has to pass
// through this person as an acknowledger while they are no longer anyone's
// current team lead/department head (needs a reassignment mid-return).
async function findInFlightDuties(admin: SupabaseClient, targetId: string, targetName: string): Promise<string[]> {
  const reasons: string[] = [];

  // 1. Approvals still waiting on them: a `pending` step in the CURRENT
  //    cycle (highest cycle_number) of a timesheet that is mid-approval.
  //    Stale `pending` rows left behind in an earlier, declined cycle are
  //    not live work and must not block.
  const { data: pendingSteps, error: pendingError } = await admin
    .from("approval_steps")
    .select("timesheet_id, cycle_number, timesheets!inner(status)")
    .eq("approver_id", targetId)
    .eq("status", "pending")
    .in("timesheets.status", LIVE_TIMESHEET_STATUSES);
  if (pendingError) throw new Error("Couldn't check pending approvals: " + pendingError.message);

  if (pendingSteps && pendingSteps.length > 0) {
    const timesheetIds = [...new Set(pendingSteps.map((s) => s.timesheet_id as string))];
    const { data: cycles, error: cyclesError } = await admin
      .from("approval_steps")
      .select("timesheet_id, cycle_number")
      .in("timesheet_id", timesheetIds);
    if (cyclesError) throw new Error("Couldn't check approval cycles: " + cyclesError.message);
    const latest = new Map<string, number>();
    for (const c of cycles ?? []) {
      latest.set(c.timesheet_id, Math.max(latest.get(c.timesheet_id) ?? 0, c.cycle_number));
    }
    const live = new Set(
      pendingSteps.filter((s) => s.cycle_number === latest.get(s.timesheet_id)).map((s) => s.timesheet_id),
    );
    if (live.size > 0) {
      reasons.push(
        `${targetName} still has ${live.size} timesheet${live.size === 1 ? "" : "s"} waiting on their approval — ` +
          "they need to approve or decline " +
          (live.size === 1 ? "it" : "them") +
          " first.",
      );
    }
  }

  // 2. Current supervisor of active staff. Only OPEN assignments
  //    (effective_to is null) count — closed history never blocks — and
  //    only where the supervised staff member is themself still active.
  const { data: assignments, error: assignmentsError } = await admin
    .from("organizational_assignments")
    .select("staff_id")
    .is("effective_to", null)
    .or(`team_lead_id.eq.${targetId},department_head_id.eq.${targetId}`);
  if (assignmentsError) throw new Error("Couldn't check current assignments: " + assignmentsError.message);

  if (assignments && assignments.length > 0) {
    const { count, error: activeError } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in(
        "id",
        assignments.map((a) => a.staff_id),
      )
      .eq("active", true);
    if (activeError) throw new Error("Couldn't check supervised staff: " + activeError.message);
    if ((count ?? 0) > 0) {
      reasons.push(
        `${targetName} is currently the team lead or department head for ${count} active staff member${
          count === 1 ? "" : "s"
        } — those staff need a new reporting line first.`,
      );
    }
  }

  return reasons;
}

export async function deactivateStaff(
  caller: SupabaseClient,
  admin: SupabaseClient,
  targetId: string,
): Promise<DeactivateResult> {
  // targetId comes from the client and is later interpolated into a
  // PostgREST filter string, so its shape is checked up front.
  if (!UUID_RE.test(targetId)) return { ok: false, error: "That account doesn't exist." };

  const {
    data: { user },
  } = await caller.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Re-verified server-side against the caller's own session — the UI
  // hiding the button is never the boundary (same rule as createStaffMember).
  const { data: callerProfile } = await caller.from("profiles").select("role, active").eq("id", user.id).single();
  if (!callerProfile || !ADMIN_ROLES.includes(callerProfile.role) || !callerProfile.active) {
    return { ok: false, error: "Only an admin can deactivate staff members." };
  }

  // Self-protection. The database has the same rule as a backstop
  // (trg_prevent_admin_self_privilege_change) but only for callers whose
  // auth.uid() is set; this check gives the friendly message and does not
  // depend on that trigger firing.
  if (targetId === user.id) {
    return { ok: false, error: "You can't deactivate your own account." };
  }

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, full_name, active")
    .eq("id", targetId)
    .maybeSingle();
  if (targetError) return { ok: false, error: "Couldn't look up that account: " + targetError.message };
  if (!target) return { ok: false, error: "That account doesn't exist." };
  if (!target.active) return { ok: false, error: `${target.full_name} is already deactivated.` };

  let reasons: string[];
  try {
    reasons = await findInFlightDuties(admin, targetId, target.full_name);
  } catch (e) {
    // Fail closed: if the safety check can't run, don't deactivate.
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't check for pending work." };
  }
  if (reasons.length > 0) {
    return { ok: false, error: `Can't deactivate yet. ${reasons.join(" ")}` };
  }

  // Flag first, through the CALLER's own RLS-bound client, so the database
  // — not just this code — is what authorises the write (profiles_update_admin
  // plus the self-change trigger). Zero rows back means RLS refused it.
  const { data: updated, error: flagError } = await caller
    .from("profiles")
    .update({ active: false })
    .eq("id", targetId)
    .select("id");
  if (flagError) return { ok: false, error: "Couldn't deactivate: " + flagError.message };
  if (!updated || updated.length === 0) return { ok: false, error: "Couldn't deactivate: not permitted." };

  // Then revoke login. If this fails, undo the flag so the two never
  // disagree (deactivated in the app but still able to sign in).
  const { error: banError } = await admin.auth.admin.updateUserById(targetId, { ban_duration: BAN_DURATION });
  if (banError) {
    const { error: undoError } = await caller.from("profiles").update({ active: true }).eq("id", targetId);
    return {
      ok: false,
      error: undoError
        ? "Deactivation half-applied and couldn't be undone — check this account by hand. " + banError.message
        : "Couldn't revoke their login, so nothing was changed: " + banError.message,
    };
  }

  return { ok: true };
}
