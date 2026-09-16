-- Kalthum for Peace — Automated Timesheet System
-- Read-only helper: who is the current expected recipient for
-- acknowledging timesheet_id's return, right now — or NULL if the caller
-- has no legitimate relationship to this timesheet, it isn't in
-- 'returning' status, or the return path has already reached the staff
-- member with nothing left to acknowledge.
--
-- Needed because the client cannot safely reconstruct this itself:
-- approval_steps RLS only exposes a caller's OWN row (or the timesheet
-- owner's), so a client-side attempt to walk "who declined, at what
-- step_order, who has already acknowledged" would hit the exact same
-- RLS-blindness already found and fixed for the approve/decline
-- turn-order check — except there's no timesheet_status value that
-- collapses "whose turn to acknowledge" the way pending_team_lead /
-- pending_department_head / pending_final_review does for approval turn.
-- A thin server-side read is the only correct option.
--
-- Authorization check first: a SECURITY DEFINER function's only real
-- boundary is what's inside it (same class of gap as the chain-generation
-- function's original open EXECUTE grant) — without this, any
-- authenticated user could learn who's expected to act on an arbitrary
-- stranger's return. Boundary mirrors timesheets_select's own actor
-- clause exactly: the timesheet's staff, or anyone who has ever appeared
-- in its approval_steps (any cycle) as an approver.
--
-- Pure read otherwise, reuses two already-applied, already-tested helpers
-- (current_return_reference_step_order, next_return_recipient) exactly as
-- acknowledge_return_timesheet and resubmit_timesheet already do — no new
-- business logic, no write, no RLS policy change.

create or replace function public.current_return_recipient(p_timesheet_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_status timesheet_status;
  v_cycle smallint;
  v_reference_step_order smallint;
begin
  select staff_id, status into v_staff_id, v_status
  from timesheets where id = p_timesheet_id;

  if v_staff_id is null then
    return null;
  end if;

  if v_staff_id != auth.uid() and not public.is_actor_on_timesheet(p_timesheet_id) then
    return null;
  end if;

  if v_status != 'returning' then
    return null;
  end if;

  select max(cycle_number) into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  if v_cycle is null then
    return null;
  end if;

  v_reference_step_order := public.current_return_reference_step_order(p_timesheet_id, v_cycle);

  -- NULL here means the path has reached staff — nothing left to
  -- acknowledge, correctly returned as NULL to the caller too.
  return public.next_return_recipient(p_timesheet_id, v_cycle, v_reference_step_order);
end;
$$;

grant execute on function public.current_return_recipient(uuid) to authenticated;
