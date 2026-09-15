-- Kalthum for Peace — Automated Timesheet System
-- Part 4: decline / return
-- DRY RUN — not yet applied.
--
-- next_return_recipient() is a reusable helper: given a reference
-- step_order, it finds the approver_id of the nearest LOWER step_order in
-- this cycle with an approved (non-skipped) row, or NULL if none exists
-- (meaning the return path is empty and goes straight to staff). decline
-- calls it once, from the declining step's own step_order. Part 5
-- (return_acknowledge) will call the exact same helper again from
-- whichever step_order the acknowledger is at, to advance one hop further
-- back — so this is built once, for reuse, not re-derived per part.
--
-- Not granted to `authenticated` — same reasoning as generate_approval_chain
-- in Part 1: it doesn't validate anything about the caller, so exposing it
-- directly would let any client query arbitrary return-path data.

create or replace function public.next_return_recipient(
  p_timesheet_id uuid,
  p_cycle smallint,
  p_from_step_order smallint
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select approver_id
  from approval_steps
  where timesheet_id = p_timesheet_id
    and cycle_number = p_cycle
    and step_order < p_from_step_order
    and status = 'approved'
  order by step_order desc
  limit 1;
$$;

revoke execute on function public.next_return_recipient(uuid, smallint, smallint) from public;
revoke execute on function public.next_return_recipient(uuid, smallint, smallint) from authenticated;
revoke execute on function public.next_return_recipient(uuid, smallint, smallint) from anon;

create or replace function public.decline_timesheet(p_timesheet_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_staff_id uuid;
  v_cycle smallint;
  v_step_id uuid;
  v_step_order smallint;
  v_step_status step_status;
  v_lower_pending_count int;
  v_next_recipient uuid;
begin
  select staff_id into v_owner_staff_id
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_owner_staff_id is null then
    raise exception 'decline_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  select max(cycle_number) into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  if v_cycle is null then
    raise exception 'decline_timesheet: timesheet % has no approval cycle', p_timesheet_id;
  end if;

  select id, step_order, status into v_step_id, v_step_order, v_step_status
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle and approver_id = auth.uid();

  if v_step_id is null then
    raise exception 'decline_timesheet: caller % has no approval step on timesheet % cycle %', auth.uid(), p_timesheet_id, v_cycle;
  end if;

  -- Redundant self-decline check — extended from Part 3's self-approval
  -- check for symmetry; not explicitly named in the Part 4 spec but the
  -- same "no self-action, checked independently of RLS" principle applies.
  if v_owner_staff_id = auth.uid() then
    raise exception 'decline_timesheet: caller % cannot decline their own timesheet %', auth.uid(), p_timesheet_id;
  end if;

  if v_step_status != 'pending' then
    raise exception 'decline_timesheet: step % on timesheet % is already % — nothing to do', v_step_id, p_timesheet_id, v_step_status;
  end if;

  -- Redundant step-ordering check — RLS enforces this for any transition
  -- out of pending, approve or decline alike.
  select count(*) into v_lower_pending_count
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle
    and step_order < v_step_order and status = 'pending';

  if v_lower_pending_count > 0 then
    raise exception 'decline_timesheet: % earlier step(s) at a lower step_order are still pending on timesheet % cycle %', v_lower_pending_count, p_timesheet_id, v_cycle;
  end if;

  if p_comment is null or length(trim(p_comment)) = 0 then
    raise exception 'decline_timesheet: a comment is required to decline (PROJECT_CONTEXT section 14)';
  end if;

  update approval_steps
  set status = 'declined', acted_at = now(), comment = p_comment
  where id = v_step_id;

  insert into timesheet_actions (timesheet_id, cycle_number, actor_id, action, comment)
  values (p_timesheet_id, v_cycle, auth.uid(), 'declined', p_comment);

  update timesheets set status = 'returning', updated_at = now() where id = p_timesheet_id;

  v_next_recipient := public.next_return_recipient(p_timesheet_id, v_cycle, v_step_order);

  if v_next_recipient is not null then
    insert into notifications (recipient_id, timesheet_id, type, title, message)
    values (v_next_recipient, p_timesheet_id, 'returned', 'Timesheet declined and returned',
            'A timesheet you approved has been declined further along the chain. Please review and acknowledge.');
  else
    -- Empty backward path — declined at the lowest step_order in this
    -- cycle, so return goes straight to staff with nothing to acknowledge.
    insert into notifications (recipient_id, timesheet_id, type, title, message)
    values (v_owner_staff_id, p_timesheet_id, 'returned', 'Timesheet declined',
            'Your timesheet was declined. Please review the comment, make corrections, and resubmit.');
  end if;
end;
$$;

grant execute on function public.decline_timesheet(uuid, text) to authenticated;
