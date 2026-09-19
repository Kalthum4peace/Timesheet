-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (demo, second round, 2026-09-18), Part 4: role-aware
-- "awaiting final review" labels.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Read-only helper: for each requested timesheet that is currently at
-- 'pending_final_review' AND visible to the caller, which approval_types
-- (spm and/or hr) are still 'pending' at the active step_order of the
-- CURRENT cycle. The UI uses this to say "Awaiting HR's Review" /
-- "Awaiting SPM's Review" / "Awaiting SPM & HR's Review" instead of a
-- static "Awaiting final review".
--
-- Why a server-side read at all (instead of the client reading
-- approval_steps): approval_steps SELECT only exposes a caller's OWN row
-- (or the timesheet owner's). An HR approver looking at a timesheet where
-- SPM is still pending, or an SPM looking at one where only HR is pending,
-- cannot see the sibling row client-side — the query would silently come
-- back short and always look falsely clear. Same RLS-blindness already found
-- and fixed for approve/decline turn order (see APPROVAL_TYPE_ACTIVE_STATUS
-- in lib/timesheet.ts) and for return acknowledgment
-- (current_return_recipient, 20260915280000).
--
-- The rule itself is NOT new logic: "pending rows at the lowest pending
-- step_order of the newest cycle" is exactly how approve_timesheet /
-- decline_timesheet already decide what is active. Self-skipped rows
-- (status 'skipped', e.g. the SPM approving their own timesheet) and
-- already-approved rows are simply not 'pending', so they drop out of the
-- label with no special casing. Prior cycles are ignored via max(cycle).
--
-- Authorization is the boundary (SECURITY DEFINER bypasses RLS, so this is
-- the ONLY thing standing between any signed-in user and an arbitrary
-- timesheet id — same class of gap as chain-generation's original open
-- EXECUTE grant and current_return_recipient's first draft). The visibility
-- predicate below is a deliberate copy of the CURRENT timesheets_select
-- policy (20260918040000_admin_hr_permissions.sql), NOT a narrower
-- "actor or staff" check like current_return_recipient uses — HR and SPM see
-- timesheets they are not yet named on, and they are exactly the people who
-- need this label. If timesheets_select is ever changed, this predicate must
-- change with it; scripts/test-pending-final-approvers.mjs asserts parity
-- between this function's visibility and a direct timesheets SELECT for
-- every persona, so drift is caught by a test rather than by memory.
--
-- Pure read: no write, no new table, no RLS policy change.

create or replace function public.pending_final_approvers(p_timesheet_ids uuid[])
returns table (ts_id uuid, pending_type approval_type)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select t.id
    from timesheets t
    where t.id = any(p_timesheet_ids)
      and t.status = 'pending_final_review'
      and (
        t.staff_id = auth.uid()
        or public.is_actor_on_timesheet(t.id)
        or public.is_team_lead_of(t.staff_id)
        or public.is_department_head_of(t.staff_id)
        or public.current_profile_role() in ('hr', 'admin_hr')
        or (
          public.current_profile_role() = 'spm'
          and (
            t.department in ('operations', 'medical')
            or public.profile_role(t.staff_id) in ('team_lead', 'department_head', 'hr', 'admin_hr')
          )
        )
      )
  ),
  newest_cycle as (
    select s.timesheet_id, max(s.cycle_number) as cycle_number
    from approval_steps s
    join visible v on v.id = s.timesheet_id
    group by s.timesheet_id
  ),
  still_pending as (
    select s.timesheet_id, s.approval_type, s.step_order
    from approval_steps s
    join newest_cycle c
      on c.timesheet_id = s.timesheet_id and c.cycle_number = s.cycle_number
    where s.status = 'pending'
  )
  select p.timesheet_id, p.approval_type
  from still_pending p
  where p.step_order = (
    select min(p2.step_order) from still_pending p2 where p2.timesheet_id = p.timesheet_id
  );
$$;

-- Omitting a grant is not the same as revoking the default PUBLIC grant
-- (lesson from 20260915200000) — so revoke explicitly, then grant to the one
-- role that should call it. anon would get zero rows anyway (auth.uid() is
-- null), but a function that shouldn't be callable shouldn't be callable.
revoke execute on function public.pending_final_approvers(uuid[]) from public;
revoke execute on function public.pending_final_approvers(uuid[]) from anon;
grant execute on function public.pending_final_approvers(uuid[]) to authenticated;
