-- Kalthum for Peace — Automated Timesheet System
-- Part 5: return acknowledgment
-- DRY RUN — not yet applied.
--
-- No stored "current recipient" pointer exists anywhere in the schema —
-- the expected recipient is derived fresh, every call, from the declined
-- row's step_order and whoever has already acknowledged this cycle (via
-- MIN(step_order), not timestamp ordering). next_return_recipient is
-- called TWICE per invocation, with two different reference points:
-- once to authorize the caller (from wherever the chain currently stands),
-- and again after recording their acknowledgment (from THEIR OWN
-- step_order) to determine who's next. Same helper, different reference
-- point each time — that's what makes this genuinely advance instead of
-- returning the same first hop forever.
--
-- Locks the timesheet row for serialization only (double-click
-- protection) — never writes to it. Never writes to approval_steps
-- either; only timesheet_actions and notifications.

create or replace function public.acknowledge_return_timesheet(p_timesheet_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_staff_id uuid;
  v_status timesheet_status;
  v_cycle smallint;
  v_declined_step_order smallint;
  v_lowest_acknowledged_step_order smallint;
  v_reference_step_order smallint;
  v_expected_recipient uuid;
  v_caller_step_order smallint;
  v_next_recipient uuid;
begin
  select staff_id, status into v_owner_staff_id, v_status
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_owner_staff_id is null then
    raise exception 'acknowledge_return_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  if v_status != 'returning' then
    raise exception 'acknowledge_return_timesheet: timesheet % is not in returning status (current status: %)', p_timesheet_id, v_status;
  end if;

  select max(cycle_number) into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  if v_cycle is null then
    raise exception 'acknowledge_return_timesheet: timesheet % has no approval cycle', p_timesheet_id;
  end if;

  select step_order into v_declined_step_order
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle and status = 'declined';

  if v_declined_step_order is null then
    raise exception 'acknowledge_return_timesheet: timesheet % cycle % has no declined step', p_timesheet_id, v_cycle;
  end if;

  -- How far back has the chain progressed so far this cycle? The lowest
  -- step_order reached, whether that's nobody yet (the decline itself) or
  -- the lowest of everyone who has already acknowledged.
  select min(ap.step_order) into v_lowest_acknowledged_step_order
  from timesheet_actions ta
  join approval_steps ap
    on ap.timesheet_id = ta.timesheet_id
   and ap.cycle_number = ta.cycle_number
   and ap.approver_id = ta.actor_id
  where ta.timesheet_id = p_timesheet_id and ta.cycle_number = v_cycle and ta.action = 'return_acknowledged';

  v_reference_step_order := coalesce(v_lowest_acknowledged_step_order, v_declined_step_order);

  v_expected_recipient := public.next_return_recipient(p_timesheet_id, v_cycle, v_reference_step_order);

  if v_expected_recipient is null then
    raise exception 'acknowledge_return_timesheet: return path for timesheet % cycle % has already reached staff — nothing left to acknowledge', p_timesheet_id, v_cycle;
  end if;

  -- The single authorization check: freshly derived, covers BOTH
  -- out-of-turn attempts and duplicate/repeat attempts by the same
  -- person, since either case fails to match the current reference point.
  if v_expected_recipient != auth.uid() then
    raise exception 'acknowledge_return_timesheet: caller % is not the current expected recipient (expected %) — out of turn or already acknowledged', auth.uid(), v_expected_recipient;
  end if;

  insert into timesheet_actions (timesheet_id, cycle_number, actor_id, action)
  values (p_timesheet_id, v_cycle, auth.uid(), 'return_acknowledged');

  select step_order into v_caller_step_order
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle and approver_id = auth.uid();

  v_next_recipient := public.next_return_recipient(p_timesheet_id, v_cycle, v_caller_step_order);

  if v_next_recipient is not null then
    insert into notifications (recipient_id, timesheet_id, type, title, message)
    values (v_next_recipient, p_timesheet_id, 'returned', 'Timesheet declined and returned',
            'A timesheet you approved has been declined further along the chain. Please review and acknowledge.');
  else
    insert into notifications (recipient_id, timesheet_id, type, title, message)
    values (v_owner_staff_id, p_timesheet_id, 'returned', 'Timesheet declined',
            'Your timesheet was declined. Please review the comment, make corrections, and resubmit.');
  end if;
end;
$$;

grant execute on function public.acknowledge_return_timesheet(uuid) to authenticated;
