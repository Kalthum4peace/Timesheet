-- generate_approval_chain: Medical staff who report directly to the
-- Department Head (no Team Lead).
--
-- Client confirmed: two Medical staff (RFP, HP Supervisor) have no Team Lead.
-- Their organizational_assignments row has team_lead_id NULL and
-- department_head_id set. Chain: department_head(1) -> hr(2). The Team Lead
-- step is simply not part of the chain (no row, not a 'skipped' row) and SPM
-- is not an approver.
--
-- Exactly three edits to the function; everything else is byte-for-byte the
-- version from 20260925000000_chain_operations_flat_and_admin.sql
-- (re-declared whole, not altered piecemeal):
--   (a) the "missing team_lead_id or department_head_id" guard: for
--       department = 'medical' a NULL team_lead_id no longer raises (a NULL
--       department_head_id still does, same message). Operations is
--       untouched (still never raises); no other department exists.
--   (b) new branch: medical + team_lead_id NULL -> department_head(1),
--       hr(2), status pending_department_head. Step 1 so the first-layer
--       notification (step_order = 1) reaches the department head.
--   (c) the existing Medical branch now only runs when team_lead_id is
--       present; its body is unchanged.
-- The new branch is scoped by department = 'medical', the Operations
-- branches by department = 'operations'; department is a single-valued
-- enum column, so no row can match both.
--
-- Only approval_steps generation changes. No RLS / visibility change: SPM's
-- read access to Medical timesheets comes from timesheets_select (department
-- in ('operations','medical')), independent of approval_steps.
--
-- CREATE OR REPLACE keeps the existing ACL, so the earlier REVOKE of EXECUTE
-- from public/anon/authenticated (20260915200000) still applies.

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

  select count(*) into v_hr_count from profiles where role in ('hr', 'admin_hr') and active = true;
  if v_hr_count != 1 then
    raise exception 'generate_approval_chain: expected exactly one active HR profile, found %', v_hr_count;
  end if;
  select id into v_hr_id from profiles where role in ('hr', 'admin_hr') and active = true limit 1;

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

    if v_department is distinct from 'operations'
       and (v_department_head_id is null
            or (v_team_lead_id is null and v_department is distinct from 'medical')) then
      raise exception 'generate_approval_chain: staff % assignment is missing team_lead_id or department_head_id', v_staff_id;
    end if;

    if v_department = 'medical' and v_team_lead_id is null then
      -- Medical staff who report directly to the Department Head (no Team
      -- Lead): department_head(1) -> hr(2). No team_lead row at all, and no
      -- SPM - HR is the final approver. Step 1 is the first layer, so the
      -- first-layer notification below reaches the department head.
      insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
      values
        (p_timesheet_id, v_cycle, 1, 'department_head', v_department_head_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 2, 'hr', v_hr_id, 'pending'::step_status);
      v_first_status := 'pending_department_head';

    elsif v_department = 'medical' then
      insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
      values
        (p_timesheet_id, v_cycle, 1, 'team_lead', v_team_lead_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 2, 'department_head', v_department_head_id, 'pending'::step_status),
        (p_timesheet_id, v_cycle, 3, 'hr', v_hr_id, 'pending'::step_status);
      v_first_status := 'pending_team_lead';

    elsif v_department = 'operations' and (v_team_lead_id is null or v_department_head_id is null) then
      -- Operations has no Team Lead / Department Head layer: straight to
      -- SPM + HR in parallel, same shape as the leadership branch below.
      insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
      values
        (p_timesheet_id, v_cycle, 1, 'spm', v_spm_id, (case when v_spm_id = v_staff_id then 'skipped' else 'pending' end)::step_status),
        (p_timesheet_id, v_cycle, 1, 'hr', v_hr_id, (case when v_hr_id = v_staff_id then 'skipped' else 'pending' end)::step_status);
      v_first_status := 'pending_final_review';

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

  elsif v_role in ('team_lead', 'department_head', 'spm', 'hr', 'admin_hr', 'admin') then
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
