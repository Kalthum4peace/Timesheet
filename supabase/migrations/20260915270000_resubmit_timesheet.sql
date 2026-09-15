-- Kalthum for Peace — Automated Timesheet System
-- Part 6: edit + resubmit
-- DRY RUN — not yet applied.
--
-- Two shared helpers extracted here so resubmit_timesheet genuinely
-- REUSES existing validation rather than duplicating it, per the
-- confirmed design questions — this also means refactoring two
-- already-applied functions (submit_timesheet, acknowledge_return_timesheet)
-- to call the extracted helpers instead of their old inline logic.
-- Behavior is unchanged for both; only the duplication is removed.

-- ============================================================
-- missing_attendance_days: extracted from submit_timesheet's inline
-- generate_series check. Not cycle-scoped — attendance_entries is one set
-- of rows per timesheet_id, edited in place between cycles, so this
-- always reflects current data with nothing to go stale.
-- ============================================================

create or replace function public.missing_attendance_days(p_timesheet_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from generate_series(
    (select make_date(year, month, 1) from timesheets where id = p_timesheet_id),
    (select (make_date(year, month, 1) + interval '1 month' - interval '1 day')::date from timesheets where id = p_timesheet_id),
    interval '1 day'
  ) as d(day)
  where not exists (
    select 1 from attendance_entries ae
    where ae.timesheet_id = p_timesheet_id and ae.date = d.day::date
  );
$$;

revoke execute on function public.missing_attendance_days(uuid) from public;
revoke execute on function public.missing_attendance_days(uuid) from authenticated;
revoke execute on function public.missing_attendance_days(uuid) from anon;

create or replace function public.submit_timesheet(p_timesheet_id uuid)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_status timesheet_status;
  v_missing_days int;
  v_cycle smallint;
begin
  select staff_id, status into v_staff_id, v_status
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_staff_id is null then
    raise exception 'submit_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  if v_staff_id != auth.uid() then
    raise exception 'submit_timesheet: caller % is not the owner of timesheet % (owner: %)', auth.uid(), p_timesheet_id, v_staff_id;
  end if;

  if v_status != 'draft' then
    raise exception 'submit_timesheet: timesheet % is not in draft status (current status: %)', p_timesheet_id, v_status;
  end if;

  select public.missing_attendance_days(p_timesheet_id) into v_missing_days;

  if v_missing_days > 0 then
    raise exception 'submit_timesheet: timesheet % is missing % day(s) of attendance entries — all days must be filled before submission', p_timesheet_id, v_missing_days;
  end if;

  v_cycle := public.generate_approval_chain(p_timesheet_id);

  return v_cycle;
end;
$$;

-- ============================================================
-- current_return_reference_step_order: extracted from
-- acknowledge_return_timesheet's inline derivation. Given a cycle, finds
-- how far the return path has progressed — the declined step's
-- step_order if nobody's acknowledged yet, else the lowest step_order
-- among everyone who has (via MIN, not timestamp ordering).
-- ============================================================

create or replace function public.current_return_reference_step_order(p_timesheet_id uuid, p_cycle smallint)
returns smallint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_declined_step_order smallint;
  v_lowest_acknowledged_step_order smallint;
begin
  select step_order into v_declined_step_order
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = p_cycle and status = 'declined';

  if v_declined_step_order is null then
    raise exception 'current_return_reference_step_order: timesheet % cycle % has no declined step', p_timesheet_id, p_cycle;
  end if;

  select min(ap.step_order) into v_lowest_acknowledged_step_order
  from timesheet_actions ta
  join approval_steps ap
    on ap.timesheet_id = ta.timesheet_id
   and ap.cycle_number = ta.cycle_number
   and ap.approver_id = ta.actor_id
  where ta.timesheet_id = p_timesheet_id and ta.cycle_number = p_cycle and ta.action = 'return_acknowledged';

  return coalesce(v_lowest_acknowledged_step_order, v_declined_step_order);
end;
$$;

revoke execute on function public.current_return_reference_step_order(uuid, smallint) from public;
revoke execute on function public.current_return_reference_step_order(uuid, smallint) from authenticated;
revoke execute on function public.current_return_reference_step_order(uuid, smallint) from anon;

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

  v_reference_step_order := public.current_return_reference_step_order(p_timesheet_id, v_cycle);
  v_expected_recipient := public.next_return_recipient(p_timesheet_id, v_cycle, v_reference_step_order);

  if v_expected_recipient is null then
    raise exception 'acknowledge_return_timesheet: return path for timesheet % cycle % has already reached staff — nothing left to acknowledge', p_timesheet_id, v_cycle;
  end if;

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

-- ============================================================
-- resubmit_timesheet: the actual Part 6 deliverable. Reuses
-- generate_approval_chain (Part 1) exactly as submit does — same fresh
-- org_assignments snapshot, same self-approval substitution, same
-- notification logic. The only genuinely new logic here is the two
-- preconditions specific to resubmission: status = 'returning' AND the
-- return path has genuinely reached staff (not just "is returning").
-- ============================================================

create or replace function public.resubmit_timesheet(p_timesheet_id uuid)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_status timesheet_status;
  v_cycle smallint;
  v_reference_step_order smallint;
  v_pending_recipient uuid;
  v_missing_days int;
  v_new_cycle smallint;
begin
  select staff_id, status into v_staff_id, v_status
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_staff_id is null then
    raise exception 'resubmit_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  if v_staff_id != auth.uid() then
    raise exception 'resubmit_timesheet: caller % is not the owner of timesheet % (owner: %)', auth.uid(), p_timesheet_id, v_staff_id;
  end if;

  if v_status != 'returning' then
    raise exception 'resubmit_timesheet: timesheet % is not in returning status (current status: %)', p_timesheet_id, v_status;
  end if;

  select max(cycle_number) into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  if v_cycle is null then
    raise exception 'resubmit_timesheet: timesheet % has no approval cycle', p_timesheet_id;
  end if;

  -- status = 'returning' alone is not enough — that's true for the whole
  -- return journey, including while an intermediate still hasn't
  -- acknowledged. Confirm the path has genuinely reached staff.
  v_reference_step_order := public.current_return_reference_step_order(p_timesheet_id, v_cycle);
  v_pending_recipient := public.next_return_recipient(p_timesheet_id, v_cycle, v_reference_step_order);

  if v_pending_recipient is not null then
    raise exception 'resubmit_timesheet: return path for timesheet % cycle % has not yet reached staff — % still needs to acknowledge', p_timesheet_id, v_cycle, v_pending_recipient;
  end if;

  select public.missing_attendance_days(p_timesheet_id) into v_missing_days;

  if v_missing_days > 0 then
    raise exception 'resubmit_timesheet: timesheet % is missing % day(s) of attendance entries — all days must be filled before resubmission', p_timesheet_id, v_missing_days;
  end if;

  -- Same function Part 1 built for the original submission — fresh
  -- organizational_assignments snapshot, self-approval substitution,
  -- notifications, all identical. cycle_number and action ('resubmitted'
  -- vs 'submitted') are entirely its own responsibility already.
  v_new_cycle := public.generate_approval_chain(p_timesheet_id);

  return v_new_cycle;
end;
$$;

grant execute on function public.resubmit_timesheet(uuid) to authenticated;
