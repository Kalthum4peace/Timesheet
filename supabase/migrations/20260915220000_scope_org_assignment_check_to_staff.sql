-- Kalthum for Peace — Automated Timesheet System
-- Fix: only the `staff` chain actually consumes organizational_assignments
-- fields (team_lead_id/department_head_id/department). The
-- team_lead/department_head/spm/hr own-timesheet chain (SPM+HR directly)
-- doesn't touch any of those fields, yet the previous version required a
-- current organizational_assignments row for EVERY role unconditionally —
-- an unrequested requirement that blocked SPM/HR from submitting their own
-- timesheet without one. Restructured so the assignment lookup+check is
-- scoped to the staff branch only, where it's actually needed.
-- DRY RUN — not yet applied.

create or replace function public.generate_approval_chain(p_timesheet_id uuid)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_role role_type;
  v_department department_type;
  v_team_lead_id uuid;
  v_department_head_id uuid;
  v_spm_id uuid;
  v_spm_count int;
  v_hr_id uuid;
  v_hr_count int;
  v_cycle smallint;
  v_action action_type;
  v_first_status timesheet_status;
begin
  select staff_id into v_staff_id
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_staff_id is null then
    raise exception 'generate_approval_chain: timesheet % not found', p_timesheet_id;
  end if;

  select role into v_role from profiles where id = v_staff_id;
  if v_role is null then
    raise exception 'generate_approval_chain: no profile found for staff_id %', v_staff_id;
  end if;

  select count(*) into v_spm_count from profiles where role = 'spm' and active = true;
  if v_spm_count != 1 then
    raise exception 'generate_approval_chain: expected exactly one active SPM profile, found %', v_spm_count;
  end if;
  select id into v_spm_id from profiles where role = 'spm' and active = true limit 1;

  select count(*) into v_hr_count from profiles where role = 'hr' and active = true;
  if v_hr_count != 1 then
    raise exception 'generate_approval_chain: expected exactly one active HR profile, found %', v_hr_count;
  end if;
  select id into v_hr_id from profiles where role = 'hr' and active = true limit 1;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  v_action := case when v_cycle = 1 then 'submitted' else 'resubmitted' end;

  if v_role = 'staff' then
    select team_lead_id, department_head_id, department
      into v_team_lead_id, v_department_head_id, v_department
    from organizational_assignments
    where staff_id = v_staff_id and effective_to is null;

    if not found then
      raise exception 'generate_approval_chain: staff % has no current (effective_to is null) organizational_assignments row', v_staff_id;
    end if;

    if v_team_lead_id is null or v_department_head_id is null then
      raise exception 'generate_approval_chain: staff % assignment is missing team_lead_id or department_head_id', v_staff_id;
    end if;

    if v_department = 'medical' then
      insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
      values
        (p_timesheet_id, v_cycle, 1, 'team_lead', v_team_lead_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 2, 'department_head', v_department_head_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 3, 'hr', v_hr_id, 'pending'::step_status);
      v_first_status := 'pending_team_lead';

    elsif v_department = 'operations' then
      insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
      values
        (p_timesheet_id, v_cycle, 1, 'team_lead', v_team_lead_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 2, 'department_head', v_department_head_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 3, 'spm', v_spm_id, (case when v_spm_id = v_staff_id then 'skipped' else 'pending' end)::step_status),
        (p_timesheet_id, v_cycle, 3, 'hr', v_hr_id, (case when v_hr_id = v_staff_id then 'skipped' else 'pending' end)::step_status);
      v_first_status := 'pending_team_lead';

    else
      raise exception 'generate_approval_chain: staff % has unrecognized department %', v_staff_id, v_department;
    end if;

  elsif v_role in ('team_lead', 'department_head', 'spm', 'hr') then
    insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
    values
      (p_timesheet_id, v_cycle, 1, 'spm', v_spm_id, (case when v_spm_id = v_staff_id then 'skipped' else 'pending' end)::step_status),
      (p_timesheet_id, v_cycle, 1, 'hr', v_hr_id, (case when v_hr_id = v_staff_id then 'skipped' else 'pending' end)::step_status);
    v_first_status := 'pending_final_review';

  else
    raise exception 'generate_approval_chain: no chain rule defined for role %', v_role;
  end if;

  insert into timesheet_actions (timesheet_id, cycle_number, actor_id, action)
  values (p_timesheet_id, v_cycle, v_staff_id, v_action);

  update timesheets set status = v_first_status, updated_at = now() where id = p_timesheet_id;

  insert into notifications (recipient_id, timesheet_id, type, title, message)
  select approver_id, p_timesheet_id, 'approval_required',
         'Timesheet awaiting your approval',
         'A timesheet has been submitted and is awaiting your review.'
  from approval_steps
  where timesheet_id = p_timesheet_id
    and cycle_number = v_cycle
    and step_order = 1
    and status = 'pending';

  return v_cycle;
end;
$$;
