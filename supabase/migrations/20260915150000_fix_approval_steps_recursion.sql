-- Kalthum for Peace — Automated Timesheet System
-- Fix: infinite recursion in approval_steps' UPDATE policy
-- DRY RUN — not yet applied.
--
-- Found by behavioral testing (scripts/test-rls.mjs): the step-ordering
-- enforcement clause in approval_steps_update_approver contained a subquery
-- selecting FROM approval_steps itself, from within approval_steps' own
-- policy. Postgres disallows this pattern outright and raises "infinite
-- recursion detected in policy for relation approval_steps" (42P17),
-- regardless of whether the logic would actually terminate — the same
-- reason every OTHER cross-referencing check in the RLS migration
-- (is_team_lead_of, is_department_head_of, is_actor_on_timesheet, etc.)
-- was written as a security definer function rather than an inline
-- subquery. This one self-referencing case was missed; this migration
-- applies the same fix.

create or replace function public.has_pending_prior_step(
  target_timesheet uuid,
  target_cycle smallint,
  target_step_order smallint
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from approval_steps
    where timesheet_id = target_timesheet
      and cycle_number = target_cycle
      and step_order < target_step_order
      and status = 'pending'
  );
$$;

grant execute on function public.has_pending_prior_step(uuid, smallint, smallint) to authenticated;

drop policy if exists approval_steps_update_approver on approval_steps;

create policy approval_steps_update_approver on approval_steps
for update to authenticated
using (
  approver_id = auth.uid()
  and status = 'pending'
  and exists (
    select 1 from timesheets t
    where t.id = approval_steps.timesheet_id and t.staff_id != auth.uid()
  )
  and not public.has_pending_prior_step(timesheet_id, cycle_number, step_order)
)
with check (
  approver_id = auth.uid()
  and status in ('approved', 'declined')
);
