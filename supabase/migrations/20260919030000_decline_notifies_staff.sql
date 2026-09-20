-- Kalthum for Peace — Automated Timesheet System
-- Staff are told about a decline the moment it happens.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- THE GAP. A decline used to produce exactly ONE notification, to whoever is
-- immediately below the decliner in the backward path. In a multi-hop chain
-- (Medical: HR declines -> Head of Medical acknowledges -> Team Lead
-- acknowledges -> reaches staff) staff heard nothing at all until the LAST
-- acknowledgment, however long that took.
--
-- THE FIX (this file). At decline time, ALWAYS insert one notification to the
-- timesheet's own staff member using the existing 'declined' notification_type
-- (defined in the enum since day one, never inserted anywhere until now). It
-- says who declined, at what stage, and quotes the decline comment.
--
-- ONE DELIBERATE EDIT to existing behaviour, and only one. When the return
-- path is empty (declined at the lowest step: nothing to acknowledge, so the
-- timesheet is back with staff at once), decline_timesheet used to send staff
-- a generic 'returned' notification. The new 'declined' notification reaches
-- the same person at the same instant with strictly more information, so
-- keeping both would send staff two near-identical emails in the same second.
-- That branch's old INSERT is therefore removed, and the new message tells
-- staff in that case that it is already back with them and editable. Nothing
-- else in the function changed.
--
-- WHAT IS NOT TOUCHED. The backward traversal and acknowledgment logic —
-- next_return_recipient, current_return_recipient,
-- current_return_reference_step_order, acknowledge_return_timesheet,
-- resubmit_timesheet — are not modified. Every check, every status change,
-- every audit-trail row and the notification to the first backward recipient
-- are byte-for-byte as before.
--
-- FIX #2 NEEDS NO CODE. The "it has genuinely reached you, go and correct it"
-- notification already exists: acknowledge_return_timesheet, after recording
-- an acknowledgment, calls next_return_recipient from the acknowledger's own
-- step_order and, when that is NULL, inserts a 'returned' notification to
-- staff. That is the same value current_return_recipient() resolves to once
-- the acknowledgment is recorded (its reference step_order IS the lowest
-- acknowledged step_order, i.e. the acknowledger's), so it fires at exactly
-- the detection point the Returned Items screen uses. Existing coverage:
-- scripts/test-acknowledge.mjs asserts staff is among the 'returned'
-- recipients after the last hop.
--
-- RESULT (staff receive):
--   multi-hop chain : 'declined' at decline time  +  'returned' when it arrives
--   short chain     : ONE 'declined' at decline time (already editable)

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
  -- added for the staff notification
  v_decliner_name text;
  v_stage text;
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
  end if;
  -- (The former "else" branch — a generic 'returned' notification to staff
  -- when the backward path is empty — is superseded by the notification
  -- below; see the header for why.)

  -- NEW: tell the timesheet's staff member immediately, whatever the chain
  -- length and whoever declined. Stage labels match the app's own
  -- (lib/timesheet.ts approvalTypeLabel): "Head of Medical"/"Head of
  -- Operations" for the department head, "Team Lead", "SPM", "HR".
  select full_name into v_decliner_name from profiles where id = auth.uid();

  select case ap.approval_type
           when 'team_lead' then 'Team Lead'
           when 'department_head' then 'Head of ' || initcap(t.department::text)
           when 'spm' then 'SPM'
           when 'hr' then 'HR'
         end
  into v_stage
  from approval_steps ap
  join timesheets t on t.id = ap.timesheet_id
  where ap.id = v_step_id;

  insert into notifications (recipient_id, timesheet_id, type, title, message)
  values (
    v_owner_staff_id,
    p_timesheet_id,
    'declined',
    'Timesheet declined by ' || coalesce(v_stage, 'an approver'),
    format(
      '%s (%s) declined your timesheet. Comment: "%s" %s',
      coalesce(v_decliner_name, 'An approver'),
      coalesce(v_stage, 'approver'),
      p_comment,
      case
        when v_next_recipient is not null
          then 'It is now being passed back through your approval chain — you will get another email as soon as it reaches you and you can make corrections.'
        else 'It has come straight back to you — please make corrections and resubmit.'
      end
    )
  );
end;
$$;

grant execute on function public.decline_timesheet(uuid, text) to authenticated;
