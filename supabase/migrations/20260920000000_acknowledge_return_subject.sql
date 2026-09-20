-- Kalthum for Peace — Automated Timesheet System
-- A distinct subject for the "it has reached you, go and correct it" email.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- WHY. Since 20260919030000 staff get two emails when a multi-hop return is
-- declined: an immediate "Timesheet declined by <stage>" (decline time) and,
-- when the return finally reaches them and they can edit, a second one whose
-- subject was the pre-existing generic "Timesheet declined". Two mails with
-- near-identical subjects read as a duplicate, and mail clients thread the
-- second one with unrelated "Timesheet declined" messages. The second email is
-- the call to action, so its subject now says so.
--
-- WHAT CHANGES. Exactly one string, inside acknowledge_return_timesheet, in
-- the branch that fires when next_return_recipient(...) is NULL (the same value
-- current_return_recipient() resolves to once the acknowledgment is recorded):
--
--   title  'Timesheet declined'
--     ->   'Your timesheet is back with you — please correct and resubmit'
--
-- The message body ('Your timesheet was declined. Please review the comment,
-- make corrections, and resubmit.'), the notification type ('returned'), the
-- recipient, the other branch's title ('Timesheet declined and returned', to
-- the next approver in the path) and ALL logic are unchanged. The function
-- below is the current definition (from 20260915270000) reproduced verbatim
-- by script, so the diff against it is that single line.

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
    values (v_owner_staff_id, p_timesheet_id, 'returned', 'Your timesheet is back with you — please correct and resubmit',
            'Your timesheet was declined. Please review the comment, make corrections, and resubmit.');
  end if;
end;
$$;

grant execute on function public.acknowledge_return_timesheet(uuid) to authenticated;
