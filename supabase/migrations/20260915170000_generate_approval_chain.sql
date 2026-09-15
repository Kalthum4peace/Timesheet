-- Kalthum for Peace — Automated Timesheet System
-- Part 1: chain-generation function
-- DRY RUN — not yet applied.
--
-- Creates a new cycle's approval_steps rows for a timesheet, records the
-- submitted/resubmitted action, advances timesheet status, and notifies
-- the first pending approver(s). Called by submit() (cycle 1) and
-- resubmit() (cycle N+1) — NOT exposed to `authenticated` directly, since
-- it does not itself validate caller identity or timesheet status; that's
-- the calling function's responsibility. See chat for design notes on:
-- (a) reconciling "hr only / spm only" chain wording with "never an
-- absent/missing row" by always creating both SPM+HR rows and letting
-- self-approval substitution skip the matching one, and (b) the two
-- hard-fail cases added beyond the literal spec (missing current
-- assignment row; assignment row missing team_lead_id/department_head_id).

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
  v_found_assignment boolean;
begin
  -- Lock the timesheet for the duration of chain generation so concurrent
  -- submit/resubmit calls on the same timesheet can't race each other.
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

  select true, team_lead_id, department_head_id, department
    into v_found_assignment, v_team_lead_id, v_department_head_id, v_department
  from organizational_assignments
  where staff_id = v_staff_id and effective_to is null;

  if not v_found_assignment then
    raise exception 'generate_approval_chain: staff % has no current (effective_to is null) organizational_assignments row', v_staff_id;
  end if;

  -- Resolve current SPM and HR. Hard-fail on anything but exactly one
  -- active profile per role — an ambiguous or missing SPM/HR blocks all
  -- Operations-track approvals, so this must be loud and specific.
  select count(*), min(id) into v_spm_count, v_spm_id
  from profiles where role = 'spm' and active = true;
  if v_spm_count != 1 then
    raise exception 'generate_approval_chain: expected exactly one active SPM profile, found %', v_spm_count;
  end if;

  select count(*), min(id) into v_hr_count, v_hr_id
  from profiles where role = 'hr' and active = true;
  if v_hr_count != 1 then
    raise exception 'generate_approval_chain: expected exactly one active HR profile, found %', v_hr_count;
  end if;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle
  from approval_steps where timesheet_id = p_timesheet_id;

  v_action := case when v_cycle = 1 then 'submitted' else 'resubmitted' end;

  if v_role = 'staff' and v_department = 'medical' then
    if v_team_lead_id is null or v_department_head_id is null then
      raise exception 'generate_approval_chain: staff % assignment is missing team_lead_id or department_head_id', v_staff_id;
    end if;
    insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
    values
      (p_timesheet_id, v_cycle, 1, 'team_lead', v_team_lead_id, 'pending'),
      (p_timesheet_id, v_cycle, 2, 'department_head', v_department_head_id, 'pending'),
      (p_timesheet_id, v_cycle, 3, 'hr', v_hr_id, 'pending');
    v_first_status := 'pending_team_lead';

  elsif v_role = 'staff' and v_department = 'operations' then
    if v_team_lead_id is null or v_department_head_id is null then
      raise exception 'generate_approval_chain: staff % assignment is missing team_lead_id or department_head_id', v_staff_id;
    end if;
    insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
    values
      (p_timesheet_id, v_cycle, 1, 'team_lead', v_team_lead_id, 'pending'),
      (p_timesheet_id, v_cycle, 2, 'department_head', v_department_head_id, 'pending'),
      (p_timesheet_id, v_cycle, 3, 'spm', v_spm_id, case when v_spm_id = v_staff_id then 'skipped' else 'pending' end),
      (p_timesheet_id, v_cycle, 3, 'hr', v_hr_id, case when v_hr_id = v_staff_id then 'skipped' else 'pending' end);
    v_first_status := 'pending_team_lead';

  elsif v_role in ('team_lead', 'department_head', 'spm', 'hr') then
    -- Direct-to-SPM+HR layer, no intermediate step — regardless of
    -- department. Self-approval substitution (below) naturally reduces
    -- this to "the other one only" when the submitter IS the resolved
    -- SPM or HR, while still leaving an auditable skipped row rather than
    -- an absent one.
    insert into approval_steps (timesheet_id, cycle_number, step_order, approval_type, approver_id, status)
    values
      (p_timesheet_id, v_cycle, 1, 'spm', v_spm_id, case when v_spm_id = v_staff_id then 'skipped' else 'pending' end),
      (p_timesheet_id, v_cycle, 1, 'hr', v_hr_id, case when v_hr_id = v_staff_id then 'skipped' else 'pending' end);
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

-- Deliberately NOT granted to `authenticated` — see file header.
