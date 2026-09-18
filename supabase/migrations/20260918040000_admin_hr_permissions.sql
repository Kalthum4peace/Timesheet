-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (demo, 2026-09-18), Part 2: merged Admin/HR role.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Every RLS policy that currently grants access on `role = 'admin'` OR
-- `role = 'hr'` is widened, deliberately and individually (not via a
-- blanket helper change), to also accept 'admin_hr'. This is intentionally
-- NOT done by redefining current_profile_role() or a shared helper to
-- silently treat admin_hr as interchangeable with admin/hr everywhere —
-- that would be a blanket bypass, the exact thing the original Admin
-- write-boundary tests were built to rule out. Each policy below is touched
-- explicitly so the boundary stays auditable per-table, the same way
-- admin's original enumerated write boundary (profiles,
-- organizational_assignments, public_holidays — nothing else) was
-- deliberately enumerated rather than derived from a role check alone.
--
-- Full audit of every place role = 'admin' / role = 'hr' appears (grepped
-- across every migration, not assumed from memory):
--   profiles_select, profiles_insert_admin, profiles_update_admin,
--   org_assignments_select, org_assignments_insert_admin,
--   org_assignments_update_admin, timesheets_select (hr clause),
--   public_holidays_insert_admin, generate_approval_chain's HR resolution
--   and its "own timesheet" role branch (separate migration below —
--   plpgsql function, not a policy).
-- approval_steps/timesheet_actions/notifications policies are role-agnostic
-- (approver_id/recipient_id = auth.uid(), or delegate to timesheets'
-- policy) and need no change. The SPM-side of chain-generation (v_spm_id/
-- v_spm_count) was checked and has NO coupling to the HR role at all —
-- confirmed by reading it, not assumed.

-- ============================================================
-- profiles
-- ============================================================

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
for select to authenticated
using (
  id = auth.uid()
  or public.is_team_lead_of(id)
  or public.is_department_head_of(id)
  or public.current_profile_role() in ('spm', 'hr', 'admin', 'admin_hr')
);

drop policy if exists profiles_insert_admin on profiles;
create policy profiles_insert_admin on profiles
for insert to authenticated
with check (public.current_profile_role() in ('admin', 'admin_hr'));

drop policy if exists profiles_update_admin on profiles;
create policy profiles_update_admin on profiles
for update to authenticated
using (public.current_profile_role() in ('admin', 'admin_hr'))
with check (public.current_profile_role() in ('admin', 'admin_hr'));
-- Note: the self-promotion guard trigger (prevent_admin_self_privilege_change)
-- already applies to ANY caller updating their own row regardless of role —
-- it needs no admin_hr-specific change, and continues to block an admin_hr
-- account from changing their own role/active status exactly as it already
-- blocks a plain admin.

-- ============================================================
-- organizational_assignments
-- ============================================================

drop policy if exists org_assignments_select on organizational_assignments;
create policy org_assignments_select on organizational_assignments
for select to authenticated
using (
  staff_id = auth.uid()
  or team_lead_id = auth.uid()
  or department_head_id = auth.uid()
  or department = public.current_profile_department()
  or public.current_profile_role() in ('spm', 'hr', 'admin', 'admin_hr')
);

drop policy if exists org_assignments_insert_admin on organizational_assignments;
create policy org_assignments_insert_admin on organizational_assignments
for insert to authenticated
with check (public.current_profile_role() in ('admin', 'admin_hr'));

drop policy if exists org_assignments_update_admin on organizational_assignments;
create policy org_assignments_update_admin on organizational_assignments
for update to authenticated
using (public.current_profile_role() in ('admin', 'admin_hr'))
with check (public.current_profile_role() in ('admin', 'admin_hr'));

-- ============================================================
-- timesheets (the HR broad-visibility clause)
-- ============================================================

drop policy if exists timesheets_select on timesheets;
create policy timesheets_select on timesheets
for select to authenticated
using (
  staff_id = auth.uid()
  or public.is_actor_on_timesheet(id)
  or public.is_team_lead_of(staff_id)
  or public.is_department_head_of(staff_id)
  or public.current_profile_role() in ('hr', 'admin_hr')
  or (
    public.current_profile_role() = 'spm'
    and (
      department in ('operations', 'medical')
      or public.profile_role(staff_id) in ('team_lead', 'department_head', 'hr', 'admin_hr')
    )
  )
);
-- The SPM clause's own profile_role(staff_id) check also widened: an
-- admin_hr account's OWN timesheet must be just as visible to SPM as HR's
-- own timesheet already is — same reasoning as the base clause, checked
-- rather than left as a latent gap.

-- ============================================================
-- public_holidays
-- ============================================================
-- Not named in the client's own admin_hr checklist (which called out
-- profile management and organizational_assignments specifically), but
-- this is still literally a place role = 'admin' currently grants access,
-- and admin_hr is meant to carry full admin capability — widened for
-- consistency with that stated principle rather than left as an
-- unexplained gap.

drop policy if exists public_holidays_insert_admin on public_holidays;
create policy public_holidays_insert_admin on public_holidays
for insert to authenticated
with check (public.current_profile_role() in ('admin', 'admin_hr') and scope = 'org');

-- ============================================================
-- generate_approval_chain: HR-slot resolution + admin_hr's OWN timesheet
-- ============================================================
--
-- Two changes, both required:
-- 1. The "exactly one active HR" resolution widens to role IN ('hr',
--    'admin_hr') per the client's explicit instruction — otherwise this
--    hard-fails against a legitimate admin_hr-only setup (0 plain 'hr'
--    profiles is currently a hard error), and must ALSO correctly still
--    hard-fail if both an 'hr' and an 'admin_hr' profile are active at once
--    (count=2, genuinely ambiguous — not silently picking one).
-- 2. admin_hr is added to the "own timesheet goes straight to SPM+HR, no
--    intermediate chain" role branch. This was NOT explicitly requested in
--    the client's checklist, but omitting it would reproduce the exact
--    dead-end bug already found and fixed once in this project (plain
--    admin has no chain rule at all, and generate_approval_chain hard-fails
--    with "no chain rule defined for role admin" if ever called for one).
--    An admin_hr account is a real staff member expected to file their own
--    attendance, same as HR today — so it's treated like HR here: SPM
--    approves, and the HR slot self-skips via the existing v_hr_id =
--    v_staff_id comparison (already role-agnostic, needs no separate
--    change). Flagged explicitly in the chat report as a judgment call,
--    not silently assumed.

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

  elsif v_role in ('team_lead', 'department_head', 'spm', 'hr', 'admin_hr') then
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
