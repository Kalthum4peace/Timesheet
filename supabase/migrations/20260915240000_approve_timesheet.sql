-- Kalthum for Peace — Automated Timesheet System
-- Part 3: approve
-- DRY RUN — not yet applied.
--
-- Locking: SELECT ... FOR UPDATE on the timesheet row (same target as
-- generate_approval_chain), taken first. This is what actually serializes
-- two different approvers (e.g. SPM and HR) acting on two different
-- approval_steps rows at the same step_order — locking only each caller's
-- own row would not, since they're different rows with no shared lock to
-- contend over. See chat for the full race-condition walkthrough.
--
-- Self-approval and step-ordering are already enforced at the RLS layer
-- (verified last session) — both are checked again here, explicitly and
-- redundantly, per the confirmed two-layer principle. The self-approval
-- check runs before the "already acted on" check specifically so it fires
-- on its own regardless of the row's current status, not only when it
-- happens to coincide with a status rejection.

create or replace function public.approve_timesheet(p_timesheet_id uuid, p_comment text default null)
returns timesheet_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_staff_id uuid;
  v_result_status timesheet_status;
  v_cycle smallint;
  v_step_id uuid;
  v_step_order smallint;
  v_step_status step_status;
  v_lower_pending_count int;
  v_unresolved_at_step_order int;
  v_next_step_order smallint;
  v_next_approval_type approval_type;
begin
  select staff_id, status into v_owner_staff_id, v_result_status
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_owner_staff_id is null then
    raise exception 'approve_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  select max(cycle_number) into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  if v_cycle is null then
    raise exception 'approve_timesheet: timesheet % has no approval cycle', p_timesheet_id;
  end if;

  select id, step_order, status into v_step_id, v_step_order, v_step_status
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle and approver_id = auth.uid();

  if v_step_id is null then
    raise exception 'approve_timesheet: caller % has no approval step on timesheet % cycle %', auth.uid(), p_timesheet_id, v_cycle;
  end if;

  -- Redundant self-approval check — fires on its own regardless of status,
  -- independent of chain-generation logic never assigning this in the
  -- first place.
  if v_owner_staff_id = auth.uid() then
    raise exception 'approve_timesheet: caller % cannot approve their own timesheet %', auth.uid(), p_timesheet_id;
  end if;

  -- Already acted on (double-click/retry, or a genuinely stale call) —
  -- clean, specific rejection, never a silent no-op.
  if v_step_status != 'pending' then
    raise exception 'approve_timesheet: step % on timesheet % is already % — nothing to do', v_step_id, p_timesheet_id, v_step_status;
  end if;

  -- Redundant step-ordering check.
  select count(*) into v_lower_pending_count
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle
    and step_order < v_step_order and status = 'pending';

  if v_lower_pending_count > 0 then
    raise exception 'approve_timesheet: % earlier step(s) at a lower step_order are still pending on timesheet % cycle %', v_lower_pending_count, p_timesheet_id, v_cycle;
  end if;

  update approval_steps
  set status = 'approved', acted_at = now(), comment = p_comment
  where id = v_step_id;

  insert into timesheet_actions (timesheet_id, cycle_number, actor_id, action, comment)
  values (p_timesheet_id, v_cycle, auth.uid(), 'approved', p_comment);

  -- Is every row at this step_order now resolved (approved or skipped)?
  select count(*) into v_unresolved_at_step_order
  from approval_steps
  where timesheet_id = p_timesheet_id and cycle_number = v_cycle
    and step_order = v_step_order and status = 'pending';

  if v_unresolved_at_step_order = 0 then
    select min(step_order) into v_next_step_order
    from approval_steps
    where timesheet_id = p_timesheet_id and cycle_number = v_cycle and step_order > v_step_order;

    if v_next_step_order is null then
      -- Last layer resolved — the timesheet is fully approved.
      v_result_status := 'approved';
      update timesheets set status = v_result_status, approved_at = now(), updated_at = now() where id = p_timesheet_id;

      insert into notifications (recipient_id, timesheet_id, type, title, message)
      values (v_owner_staff_id, p_timesheet_id, 'final_approval', 'Timesheet fully approved',
              'Your timesheet has completed the approval process and is now approved.');
    else
      -- Status reflects layer TYPE, not step_order position — 'spm'/'hr'
      -- always mean pending_final_review regardless of numeric step_order,
      -- same reasoning as chain-generation's status tagging.
      select approval_type into v_next_approval_type
      from approval_steps
      where timesheet_id = p_timesheet_id and cycle_number = v_cycle and step_order = v_next_step_order
      limit 1;

      v_result_status := (case v_next_approval_type
        when 'team_lead' then 'pending_team_lead'
        when 'department_head' then 'pending_department_head'
        else 'pending_final_review'
      end)::timesheet_status;

      update timesheets set status = v_result_status, updated_at = now() where id = p_timesheet_id;

      insert into notifications (recipient_id, timesheet_id, type, title, message)
      select approver_id, p_timesheet_id, 'approval_required', 'Timesheet awaiting your approval',
             'A timesheet has advanced to your review stage.'
      from approval_steps
      where timesheet_id = p_timesheet_id and cycle_number = v_cycle and step_order = v_next_step_order and status = 'pending';
    end if;
  end if;
  -- else: this step_order still has an unresolved sibling (e.g. SPM
  -- approved, HR hasn't yet) — v_result_status stays whatever it already
  -- was, timesheet status is deliberately left untouched.

  return v_result_status;
end;
$$;

grant execute on function public.approve_timesheet(uuid, text) to authenticated;
