import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApprovalType } from "@/lib/timesheet";

export type PendingFinalMap = Record<string, ApprovalType[]>;

// Batch read of which final approvers (spm/hr) are still pending, keyed by
// timesheet id. Only timesheets at pending_final_review the caller can see
// come back — see migration 20260918050000. A failed call degrades to an
// empty map, which the label logic renders as the generic "Awaiting final
// review": this is a display nicety, and it must never block a screen.
export async function fetchPendingFinalApprovers(
  supabase: SupabaseClient,
  timesheetIds: string[],
): Promise<PendingFinalMap> {
  if (timesheetIds.length === 0) return {};
  const { data, error } = await supabase.rpc("pending_final_approvers", {
    p_timesheet_ids: timesheetIds,
  });
  if (error || !data) return {};
  const byTimesheet: PendingFinalMap = {};
  for (const row of data as { ts_id: string; pending_type: ApprovalType }[]) {
    (byTimesheet[row.ts_id] ??= []).push(row.pending_type);
  }
  return byTimesheet;
}
